import type { NoteRepo } from '@/lib/db/repositories';
import { backoff } from '@/lib/upload/backoff';
import { mergeRemote, onRejected, remoteFields, type MergeAction, type Note, type RemoteNote } from './model';

export interface NoteRemote {
  push(note: Note, deviceId: string): Promise<void>;
  fetchFromServer(eventId: string, id: string): Promise<RemoteNote | null>;
  subscribe(eventId: string, next: (docs: { note: RemoteNote; pending: boolean }[]) => void, error: (e: unknown) => void): () => void;
}
interface Dependencies {
  repo: NoteRepo; remote: NoteRemote; deviceId: string; owner: string; now?: () => number;
  random?: () => number; changed?: () => void; canSync?: () => boolean;
}
/** RN-free durable outbox. A server acknowledgement never holds the drain lane. */
export class NoteSyncEngine {
  private inFlight = new Set<string>();
  private watches = new Map<string, { refs: number; release: () => void }>();
  private stopped = false;
  private epoch = 0;
  private running = false;
  private busy = false;
  private rerun = false;
  private timer?: ReturnType<typeof setTimeout>;
  private now: () => number;
  constructor(private d: Dependencies) { this.now = d.now ?? Date.now; }
  start() { this.epoch++; this.inFlight.clear(); this.stopped = false; this.running = true; this.notify(); }
  stop() {
    this.epoch++;
    this.stopped = true; this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watch of this.watches.values()) watch.release();
    this.watches.clear();
  }
  private active() { return !this.stopped && (this.d.canSync?.() ?? true); }
  notify() {
    if (!this.running || !this.active()) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.busy) { this.rerun = true; return; }
    this.busy = true;
    void this.tick().catch(() => true).then(pending => {
      this.busy = false;
      if (!this.running || !this.active()) return;
      if (this.rerun) { this.rerun = false; this.notify(); }
      else if (pending) this.timer = setTimeout(() => this.notify(), 30_000);
    });
  }
  async tick(): Promise<boolean> {
    if (!this.active()) return false;
    const epoch = this.epoch;
    const rows = await this.d.repo.pendingNotes(this.d.owner, this.now());
    for (const note of rows.slice(0,50)) {
      if (!this.active() || epoch !== this.epoch) break;
      if (note.owner_uid !== this.d.owner) continue;
      const key = `${note.id}:${note.revision}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      // Promise.resolve also handles an adapter that throws synchronously.
      void Promise.resolve().then(() => this.active() && epoch === this.epoch ? this.d.remote.push(note, this.d.deviceId) : undefined)
        .then(() => { if (epoch === this.epoch) return this.ack(note, note.revision); }, error => { if (epoch === this.epoch) return this.rejected(note, error, epoch); })
        .catch(() => { /* Durable row remains available for the next pass. */ })
        .finally(() => { if (epoch === this.epoch) { this.inFlight.delete(key); this.d.changed?.(); this.notify(); } });
    }
    // Includes rows backing off, so they still get a timer when nothing is due yet.
    return (await this.d.repo.pendingNotes(this.d.owner, Number.MAX_VALUE)).length > 0;
  }
  private async ack(pushed: Note, revision: number) {
    if (!this.active()) return;
    const epoch = this.epoch;
    await this.d.repo.updateNote(pushed.id, current => {
      if (!this.active() || epoch !== this.epoch || current.owner_uid !== this.d.owner) return {};
      const advanced = revision >= current.synced_revision;
      return { synced_revision: Math.max(current.synced_revision, revision),
        ...(advanced ? { remote_device: this.d.deviceId } : {}),
        ...(current.revision <= revision && current.sync_state === 'pending' ? { sync_state: 'synced', last_error: null, attempts: 0, next_attempt_at: 0 } : {}) };
    });
  }
  private async rejected(pushed: Note, error: unknown, epoch: number) {
    if (!this.active()) return;
    const code = String((error as { code?: string })?.code ?? 'unknown').replace(/^firestore\//, '');
    if (code === 'permission-denied') {
      try {
        const server = await this.d.remote.fetchFromServer(pushed.event_id, pushed.id);
        if (!this.active() || epoch !== this.epoch) return;
        const current = await this.d.repo.note(pushed.id);
        if (!current || current.owner_uid !== this.d.owner) return;
        const action = onRejected(current, server, this.d.deviceId, pushed.revision);
        if (action.type === 'ack') await this.ack(pushed, action.revision);
        else await this.d.repo.updateNote(pushed.id, n => this.active() && epoch === this.epoch && n.revision === pushed.revision && n.sync_state === 'pending' ? this.patch(n, action) : {});
      } catch { await this.retry(pushed, 'fetch_unavailable'); }
    } else if (['invalid-argument','failed-precondition'].includes(code)) {
      await this.d.repo.updateNote(pushed.id, n => this.active() && epoch === this.epoch && n.revision === pushed.revision && n.sync_state === 'pending' ? { sync_state: 'failed', last_error: code } : {});
    } else await this.retry(pushed, code);
  }
  private async retry(pushed: Note, code: string) {
    if (!this.active()) return;
    const epoch = this.epoch;
    await this.d.repo.updateNote(pushed.id, n => this.active() && epoch === this.epoch && n.revision === pushed.revision && n.sync_state === 'pending' ? {
      last_error: code, attempts: n.attempts + 1,
      next_attempt_at: this.now() + Math.max(1, backoff(n.attempts + 1, undefined, this.d.random))
    } : {});
  }
  private patch(local: Note, action: MergeAction): Partial<Note> {
    switch (action.type) {
      case 'ignore': return {};
      case 'apply': return remoteFields(action.remote);
      case 'conflict': return { sync_state: 'conflict', remote_json: JSON.stringify(action.remote), last_error: null };
      case 'failed': return { sync_state: 'failed', last_error: action.code };
      case 'ack': return { synced_revision: Math.max(local.synced_revision, action.revision), remote_device: this.d.deviceId,
        ...(action.revision >= local.revision && local.sync_state === 'pending' ? { sync_state: 'synced', last_error: null, attempts: 0 } : {}) };
    }
  }
  async pull(eventId: string, docs: { note: RemoteNote; pending: boolean }[]) {
    const epoch = this.epoch;
    for (const { note, pending } of docs) {
      if (!this.active() || epoch !== this.epoch) return;
      if (pending || note.ownerId !== this.d.owner) continue;
      const local = await this.d.repo.note(note.id);
      if (!this.active() || epoch !== this.epoch) return;
      if (local && (local.owner_uid !== this.d.owner || local.event_id !== eventId)) continue;
      if (!local) {
        const row = { id: note.id, event_id: eventId, owner_uid: note.ownerId, ...remoteFields(note) } as Note;
        // Concurrent subscriptions can observe the same new document. Unique id wins.
        try { await this.d.repo.putNote(row); } catch { /* Next snapshot reconciles it. */ }
      } else await this.d.repo.updateNote(note.id, n => this.active() && epoch === this.epoch ? this.patch(n, mergeRemote(n, note, this.d.deviceId)) : {});
    }
    this.d.changed?.();
  }
  watch(eventId: string): () => void {
    if (!this.active()) return () => {};
    const existing = this.watches.get(eventId);
    if (existing) existing.refs++;
    else {
      const release = this.d.remote.subscribe(eventId, docs => { void this.pull(eventId, docs).catch(() => {}); }, () => this.d.changed?.());
      this.watches.set(eventId, { refs: 1, release });
    }
    let released = false;
    return () => {
      if (released) return; released = true;
      const watch = this.watches.get(eventId);
      if (watch && --watch.refs === 0) { watch.release(); this.watches.delete(eventId); }
    };
  }
}

// Native lifecycle dependencies are loaded only by the thin production wrapper.
let engine: NoteSyncEngine | undefined;
let generation = 0;
let removeListeners: (() => void) | undefined;
const listeners = new Set<() => void>();
const requested = new Map<string, number>();
const releases = new Map<string, () => void>();
export function onNotesChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function notesChanged() { for (const listener of listeners) listener(); }
export const noteSync = {
  async start(owner: string) {
    this.stop(); const token = generation;
    const [{ repositories }, { noteRemote }, { deviceId }, { AppState }, { addNetworkStateListener }, { useAuthStore }, { auth }] = await Promise.all([
      import('@/lib/db/repositories'), import('@/lib/firebase/notes'), import('./deviceId'),
      import('react-native'), import('expo-network'), import('@/state/authStore'), import('@/lib/firebase/auth')
    ]);
    const [repo, id] = await Promise.all([repositories(), deviceId()]);
    if (token !== generation) return;
    engine = new NoteSyncEngine({ repo, remote: noteRemote, deviceId: id, owner, changed: notesChanged,
      canSync: () => useAuthStore.getState().user?.uid === owner && auth.current()?.uid === owner });
    const network = addNetworkStateListener(s => { if (s.isConnected !== false) engine?.notify(); });
    const app = AppState.addEventListener('change', s => { if (s === 'active') engine?.notify(); });
    removeListeners = () => { network.remove(); app.remove(); };
    engine.start();
    for (const eventId of requested.keys()) releases.set(eventId, engine.watch(eventId));
  },
  stop() { generation++; engine?.stop(); engine = undefined; removeListeners?.(); removeListeners = undefined; releases.clear(); },
  notify() { notesChanged(); engine?.notify(); },
  watch(eventId: string) {
    requested.set(eventId, (requested.get(eventId) ?? 0) + 1);
    if (!releases.has(eventId) && engine) releases.set(eventId, engine.watch(eventId));
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (requested.get(eventId) ?? 1) - 1;
      if (count) requested.set(eventId, count);
      else { requested.delete(eventId); releases.get(eventId)?.(); releases.delete(eventId); }
    };
  }
};
