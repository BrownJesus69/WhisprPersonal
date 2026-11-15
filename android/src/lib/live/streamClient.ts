import { parseServerUrl } from '../server/serverUrl.ts';
import { isMode, parseEvent } from './events.ts';
import type { LanguageMode, PartialEvent, PersistedEvent } from './events.ts';
import type { SocketFactory, WebSocketLike } from './socket.ts';

export type LiveStatus = 'live' | 'reconnecting' | 'waiting_for_server' | 'offline' | 'auth_required' | 'not_allowed' | 'stopped';
export interface StreamDependencies {
  serverUrl: string; socket: SocketFactory;
  getBearer: () => Promise<string>; getServerKey: () => Promise<string | null>; onAuthExpired: () => Promise<void>;
  session: (id: string) => Promise<{ server_created: number; last_event_seq?: number; server_finalized_at?: string | null } | null>;
  persist: (event: PersistedEvent) => Promise<void>; resetLastEventSeq: (id: string) => Promise<void>;
  apply: (event: PersistedEvent | PartialEvent) => void;
  applyPartials?: (events: PartialEvent[]) => void;
  status: (status: LiveStatus, attempt: number) => void;
  onOpen?: () => void; onReset?: () => void; log?: (code: string) => void;
  now?: () => number; random?: () => number;
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout };
}

/** Ordered persistence precedes dispatch and cursor movement. Native modules are injected. */
export class StreamClient {
  private d: StreamDependencies;
  private socket?: WebSocketLike;
  private detach?: () => void;
  private sessionId?: string;
  private active = false;
  private blocked = false;
  private generation = 0;
  private lastSeq = 0;
  private attempt = 0;
  private refreshed = false;
  private deleted = false;
  private finalized = false;
  private helloSeq = 0;
  private queue: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private healthy?: ReturnType<typeof setTimeout>;
  private partialTimer?: ReturnType<typeof setTimeout>;
  private partials = new Map<number, PartialEvent>();
  private lastPartialAt = -Infinity;
  private now: () => number;
  private random: () => number;
  private timers: { set: typeof setTimeout; clear: typeof clearTimeout };
  constructor(deps: StreamDependencies) {
    this.d = deps; this.now = deps.now ?? Date.now; this.random = deps.random ?? Math.random;
    this.timers = deps.timers ?? { set: setTimeout, clear: clearTimeout };
  }
  async start(id: string): Promise<void> {
    if (this.active && this.sessionId === id) return;
    this.active = false; this.clear('retry'); this.release();
    this.active = true; this.blocked = false; this.sessionId = id;
    this.attempt = 0; this.refreshed = false; this.deleted = false; this.finalized = false;
    this.state('reconnecting');
    await this.connect();
  }
  private state(status: LiveStatus) { this.d.status(status, this.attempt); }
  private clear(name: 'retry' | 'watchdog' | 'healthy' | 'partialTimer') {
    if (this[name] !== undefined) this.timers.clear(this[name]);
    this[name] = undefined;
  }
  private release() {
    this.generation++;
    this.detach?.(); this.detach = undefined;
    const socket = this.socket; this.socket = undefined;
    for (const name of ['watchdog', 'healthy', 'partialTimer'] as const) this.clear(name);
    this.partials.clear();
    try { socket?.close(1000); } catch { /* Already closed. */ }
  }
  private watch() {
    this.clear('watchdog');
    this.watchdog = this.timers.set(() => this.schedule(), 50_000);
  }
  private async connect() {
    if (!this.active || this.blocked || !this.sessionId) return;
    const generation = ++this.generation;
    const valid = () => this.active && generation === this.generation;
    try {
      const session = await this.d.session(this.sessionId);
      if (!valid()) return;
      if (!session?.server_created) { this.state('waiting_for_server'); this.active = false; return; }
      this.lastSeq = session.last_event_seq ?? 0;
      this.finalized = !!session.server_finalized_at;
      const base = parseServerUrl(this.d.serverUrl).url.replace(/^http/, 'ws');
      const key = await this.d.getServerKey();
      if (!valid()) return;
      if (!key) { this.blocked = true; this.state('auth_required'); return; }
      const bearer = await this.d.getBearer();
      if (!valid()) return;
      if (!bearer) { this.blocked = true; this.state('auth_required'); return; }
      const socket = this.d.socket(`${base}/api/v1/sessions/${encodeURIComponent(this.sessionId)}/stream?after_seq=${this.lastSeq}`, {
        'X-WhisprPersonal-Server-Key': key, Authorization: `Bearer ${bearer}`
      });
      this.socket = socket;
      const open = () => { if (valid()) this.watch(); };
      const message = (e: { data: unknown }) => {
        if (!valid()) return;
        this.watch();
        this.queue = this.queue.then(async () => {
          if (!valid()) return;
          await this.receive(e.data, valid);
        }).catch(() => { this.d.log?.('stream_persistence_failed'); if (valid()) this.schedule(); });
      };
      const close = (e: { code: number }) => {
        // Preserve events already received before handling the terminal close.
        this.queue = this.queue.then(() => { if (valid()) return this.closed(e.code); }).catch(() => { if (valid()) this.schedule(); });
      };
      const error = () => {
        // RN emits a close after error. A short fallback also covers transports that don't.
        if (valid()) { this.clear('watchdog'); this.watchdog = this.timers.set(() => { if (valid()) this.schedule(); }, 1000); }
      };
      socket.addEventListener('open', open); socket.addEventListener('message', message);
      socket.addEventListener('close', close); socket.addEventListener('error', error);
      this.detach = () => {
        socket.removeEventListener('open', open); socket.removeEventListener('message', message);
        socket.removeEventListener('close', close); socket.removeEventListener('error', error);
      };
      this.watch();
    } catch (error) {
      if (!valid()) return;
      const code = (error as { code?: string })?.code;
      if (code === 'auth_token_expired' || code === 'renew_required') { this.blocked = true; this.state('auth_required'); }
      else this.schedule();
    }
  }
  private async receive(input: unknown, valid: () => boolean) {
    const event = parseEvent(input);
    if (!event) { this.d.log?.('malformed_stream_event'); return; }
    if ('session_id' in event && event.session_id !== this.sessionId) { this.d.log?.('stream_session_mismatch'); return; }
    if (event.type === 'ping') { this.send({ type: 'pong' }); return; }
    if (event.type === 'error') { this.d.log?.(event.code); return; }
    if (event.type === 'hello') {
      if (event.last_event_seq < this.lastSeq) {
        await this.d.resetLastEventSeq(this.sessionId!);
        if (!valid()) return;
        this.lastSeq = 0; this.d.onReset?.(); this.schedule(4008); return;
      }
      this.helloSeq = event.last_event_seq;
      if (this.finalized && this.lastSeq >= this.helloSeq) { this.stop(); return; }
      this.state('live'); this.d.onOpen?.();
      this.clear('healthy');
      this.healthy = this.timers.set(() => { this.attempt = 0; this.state('live'); }, 30_000);
      return;
    }
    if (event.type === 'transcript_partial') {
      this.partials.set(event.sequence, event);
      const flush = () => {
        this.partialTimer = undefined; this.lastPartialAt = this.now();
        if (this.d.applyPartials) this.d.applyPartials([...this.partials.values()]);
        else for (const partial of this.partials.values()) this.d.apply(partial);
        this.partials.clear();
      };
      if (this.now() - this.lastPartialAt >= 200) flush();
      else if (this.partialTimer === undefined) this.partialTimer = this.timers.set(flush, 200 - (this.now() - this.lastPartialAt));
      return;
    }
    if (event.seq <= this.lastSeq) return;
    await this.d.persist(event);
    if (!valid()) return;
    this.lastSeq = event.seq;
    if (event.type === 'transcript_final' || event.type === 'transcript_revised' || event.type === 'chunk_failed') this.partials.delete(event.data.sequence);
    this.d.apply(event);
    if (event.type === 'session_deleted') { this.deleted = true; this.stop(); return; }
    if (event.type === 'session_finalized') this.finalized = true;
    if (this.finalized && this.lastSeq >= this.helloSeq) this.stop();
  }
  private async closed(code: number) {
    if (code === 4401) {
      this.release();
      if (this.refreshed) { this.blocked = true; this.state('auth_required'); return; }
      this.refreshed = true;
      const generation = this.generation;
      try { await this.d.onAuthExpired(); }
      catch { if (this.active && generation === this.generation) { this.blocked = true; this.state('auth_required'); } return; }
      if (this.active && generation === this.generation) this.schedule();
    } else if (code === 4403) { this.release(); this.blocked = true; this.state('not_allowed'); }
    else if (code === 1000 && this.deleted) this.stop();
    else this.schedule(code);
  }
  private schedule(code?: number) {
    this.release(); this.clear('retry');
    if (!this.active || this.blocked) return;
    let delay = 0;
    if (code === 4404) { delay = 30_000; this.state('waiting_for_server'); }
    else if (code !== 4008) {
      this.attempt++;
      delay = this.random() * Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
      if (code === 4429) delay = Math.max(10_000, delay);
      this.state('reconnecting');
    } else this.state('reconnecting');
    this.retry = this.timers.set(() => { this.retry = undefined; void this.connect(); }, delay);
  }
  private send(value: object): boolean {
    if (this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(value)); return true; } catch { return false; }
  }
  setLanguage(mode: LanguageMode): boolean { return isMode(mode) && this.send({ type: 'set_language', language: mode }); }
  reconnect() { if (this.active && !this.blocked) this.schedule(4008); }
  /** Architect driver hook: force subscriber-overflow recovery with the real cursor. */
  forceReconnectForCheck() { try { this.socket?.close(4008); } finally { this.reconnect(); } }
  stop() {
    this.active = false; this.clear('retry'); this.release(); this.state('stopped');
  }
}
