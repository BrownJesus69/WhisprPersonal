import { AppState } from 'react-native';
import { addNetworkStateListener } from 'expo-network';
import { ServerError, ServerClient } from '@/lib/server/client';
import { authedClient } from '@/lib/server/authedClient';
import type { ChunkUploadResponse, SessionResponse, FinalizeResponse } from '@/lib/server/types';
import type { Repositories, LocalChunk, LocalSession } from '@/lib/db/repositories';
import { repositories, transcriptRow } from '@/lib/db/repositories';
import { isFinalData } from '@/lib/live/events';
import { chunkLanguage } from '@/lib/live/languageOverride';
import { deleteAudio } from '@/lib/audio/chunkFiles';
import { updateEventStatus } from '@/lib/firebase/events';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useAuthStore } from '@/state/authStore';
import { backoff } from './backoff';

const authCodes = new Set(['missing_server_key','invalid_server_key','server_not_configured','account_not_allowed','auth_not_configured','renew_required','auth_token_expired','invalid_token','unauthorized']);
const listeners = new Set<(sessionId: string) => void>();
export function onUploadProgress(listener: (sessionId: string) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function progress(id: string) { for (const listener of listeners) listener(id); }
/** While paused, retry once per minute (a still-broken config just pauses again). */
export const PAUSED_PROBE_MS = 60_000;
export function outcome(error: unknown): 'pause' | 'permanent' | 'transient' | 'missing' {
  if (!(error instanceof ServerError)) return 'transient';
  // The laptop briefly lost internet (Google signing certs): retry with backoff, do not pause.
  if (error.code === 'auth_unavailable') return 'transient';
  if (authCodes.has(error.code) || error.status === 401 || error.status === 403) return 'pause';
  if (error.status === 404) return 'missing';
  if ([409,413,415,422].includes(error.status)) return 'permanent';
  return 'transient';
}
export function nextWork(sessions: LocalSession[], chunks: LocalChunk[], now: number): LocalChunk | undefined {
  const order = new Map(sessions.map((s,i) => [s.id,i]));
  return chunks.filter(c => c.status === 'pending' && c.next_attempt_at <= now && order.has(c.session_id))
    .sort((a,b) => order.get(a.session_id)! - order.get(b.session_id)! || a.sequence - b.sequence)[0];
}
interface Dependencies {
  repo: Repositories; client: Pick<ServerClient, 'post' | 'get' | 'postMultipart'>; owner: string;
  now?: () => number; random?: () => number; deleteAfter: () => boolean;
  removeFile: (uri: string) => void | Promise<void>;
  connection: (status: 'connected' | 'error' | 'renew_required' | 'disconnected') => void;
  eventStatus: (id: string, status: 'completed') => void;
}

/** One worker owns a single request lane. All upload progress lives in SQLite. */
export class UploadService {
  private running = false;
  private busy = false;
  private paused = false;
  private rerun = false;
  private cancelled = false;
  private draining?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private polls = new Map<string, number>();
  private sessionRetry = new Map<string, number>();
  private now: () => number;
  constructor(private d: Dependencies) { this.now = d.now ?? Date.now; }
  start() { this.cancelled = false; this.running = true; this.notify(); }
  stop(): Promise<void> { this.cancelled = true; this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; return this.draining ?? Promise.resolve(); }
  notify(resume = false) {
    if (resume) this.paused = false;
    if (!this.running || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.busy) { this.rerun = true; return; }
    this.draining = this.drain();
  }
  private async drain() {
    this.busy = true;
    let pending = true;
    try { pending = await this.tick(); }
    catch { this.d.connection('error'); }
    finally {
      this.busy = false;
      if (this.rerun && this.running && !this.paused) { this.rerun = false; this.notify(); }
      else if (pending && this.running && !this.paused) this.timer = setTimeout(() => this.notify(), 5000);
    }
  }
  private path(s: LocalSession) { return `/api/v1/sessions/${s.id}`; }
  private async ensureSession(s: LocalSession, force = false) {
    if (s.server_created && !force) return;
    await this.d.client.post('/api/v1/sessions', { session_id: s.id, event_id: s.event_id,
      language_mode: s.language_mode, expected_languages: s.expected_languages, model_profile: 'turbo', overlap_ms: s.overlap_ms });
    await this.d.repo.updateSession(s.id, { server_created: 1 });
    s.server_created = 1;
    progress(s.id);
  }
  private pause(error: unknown) {
    if (outcome(error) !== 'pause') return false;
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.notify(true), PAUSED_PROBE_MS);
    this.d.connection(error instanceof ServerError && ['renew_required','auth_token_expired','auth_unavailable'].includes(error.code) ? 'renew_required' : 'error');
    return true;
  }
  private async upload(s: LocalSession, c: LocalChunk) {
    const { repo, client } = this.d;
    await repo.updateChunk(c.chunk_id, { status: 'uploading' });
    try {
      await this.ensureSession(s);
      if (this.cancelled) { await repo.updateChunk(c.chunk_id, { status: 'pending' }); return; }
      const form = new FormData();
      const latest = await repo.session(s.id);
      const language = latest ? chunkLanguage(latest, c.sequence) : undefined;
      if (language) form.append('language', language);
      for (const [key, value] of Object.entries({ chunk_id: c.chunk_id, sequence: c.sequence, start_ms: c.start_ms,
        end_ms: c.end_ms, overlap_ms: c.overlap_ms, continues: !!c.continues, sha256: c.sha256 })) form.append(key, String(value));
      form.append('file', { uri: c.uri, name: c.uri.split('/').pop()!, type: 'audio/wav' } as unknown as Blob);
      let response: ChunkUploadResponse;
      try { response = await client.postMultipart<ChunkUploadResponse>(`${this.path(s)}/chunks`, form, { timeoutMs: 60000 }); }
      catch (e) {
        if (outcome(e) !== 'missing') throw e;
        await repo.updateSession(s.id, { server_created: 0 });
        await this.ensureSession(s, true);
        if (this.cancelled) { await repo.updateChunk(c.chunk_id, { status: 'pending' }); return; }
        response = await client.postMultipart<ChunkUploadResponse>(`${this.path(s)}/chunks`, form, { timeoutMs: 60000 });
      }
      await repo.updateChunk(c.chunk_id, { status: 'uploaded', server_status: response.status, last_error: null, next_attempt_at: 0 });
      if (!this.cancelled) this.d.connection('connected');
    } catch (e) {
      const code = e instanceof ServerError ? e.code : 'upload_unavailable';
      if (this.pause(e)) { await repo.updateChunk(c.chunk_id, { status: 'pending', last_error: code }); return; }
      if (outcome(e) === 'permanent') await repo.updateChunk(c.chunk_id, { status: 'failed_permanent', last_error: code });
      else {
        await repo.updateChunk(c.chunk_id, { status: 'pending', attempts: c.attempts + 1, last_error: code,
          next_attempt_at: this.now() + backoff(c.attempts + 1, e instanceof ServerError ? e.retryAfterS : undefined, this.d.random) });
        this.d.connection('disconnected');
      }
    }
  }
  /** Testable single pass; production calls through the non-overlapping drain loop. */
  async tick(): Promise<boolean> {
    if (this.paused || this.cancelled) return false;
    const sessions = await this.d.repo.sessions(this.d.owner);
    let all = (await Promise.all(sessions.map(s => this.d.repo.chunks(s.id)))).flat();
    const c = nextWork(sessions, all, this.now());
    if (this.cancelled) return false;
    if (c) { await this.upload(sessions.find(s => s.id === c.session_id)!, c); if (this.paused || this.cancelled) return false; }
    for (const s of sessions) {
      if (this.cancelled) return false;
      if (this.paused || (this.sessionRetry.get(s.id) ?? 0) > this.now()) continue;
      let chunks = await this.d.repo.chunks(s.id);
      const needsPoll = chunks.some(c => c.status === 'uploaded') || s.status === 'finalizing';
      try {
        if (needsPoll && (this.polls.get(s.id) ?? -Infinity) + 10000 <= this.now()) {
          this.polls.set(s.id, this.now());
          const observedSeq = (await this.d.repo.session(s.id))?.last_event_seq ?? 0;
          let result: SessionResponse;
          try { result = await this.d.client.get<SessionResponse>(`${this.path(s)}?after_sequence=-1&limit=1000`); }
          catch (e) {
            if (outcome(e) !== 'missing') throw e;
            await this.ensureSession(s, true);
            // A laptop database reset lost its queue. Replay retained files idempotently.
            for (const c of chunks) if (c.status === 'uploaded') await this.d.repo.updateChunk(c.chunk_id, { status: 'pending', next_attempt_at: 0 });
            continue;
          }
          // Paginate long events rather than silently leaving chunks after sequence 999 unpolled.
          let page = result.chunks;
          const remote = [...page];
          while (page.length === 1000) {
            if (this.cancelled) return false;
            const after = page[page.length - 1].sequence;
            const next = await this.d.client.get<SessionResponse>(`${this.path(s)}?after_sequence=${after}&limit=1000`);
            page = next.chunks;
            if (page.length && page[page.length - 1].sequence <= after) throw new Error('Invalid poll page');
            remote.push(...page);
          }
          for (const remoteChunk of remote) {
            if (remoteChunk.status === 'done' && isFinalData(remoteChunk)) await this.d.repo.upsertTranscript(transcriptRow(s.id, remoteChunk), observedSeq);
            const local = chunks.find(c => c.chunk_id === remoteChunk.chunk_id);
            if (local && ['uploaded','transcribed'].includes(local.status)) await this.d.repo.updateChunk(local.chunk_id, {
              status: remoteChunk.status === 'done' ? 'transcribed' : local.status,
              server_status: remoteChunk.status, last_error: remoteChunk.error_code ?? null
            });
          }
          chunks = await this.d.repo.chunks(s.id);
          progress(s.id);
          this.d.connection('connected');
        }
        if (this.cancelled) return false;
        if (this.d.deleteAfter()) for (const c of chunks) if (c.status === 'transcribed' && !c.local_deleted) {
          await this.d.removeFile(c.uri);
          await this.d.repo.updateChunk(c.chunk_id, { local_deleted: 1 });
        }
        if (['stopped','finalizing'].includes(s.status) && s.finalize_status !== 'interrupted' && chunks.length === s.next_sequence && chunks.every(c => ['uploaded','transcribed'].includes(c.status))) {
          if (s.status === 'finalizing' && (this.sessionRetry.get(s.id) ?? 0) > this.now()) continue;
          await this.ensureSession(s);
          const result = await this.d.client.post<FinalizeResponse>(`${this.path(s)}/finalize`, { expected_chunk_count: s.next_sequence, force: false });
          const finalized = result.status === 'finalized';
          await this.d.repo.updateSession(s.id, { status: finalized ? 'finalized' : 'finalizing', expected_chunk_count: s.next_sequence, finalize_status: result.transcript_status ?? result.status, last_error: null });
          this.sessionRetry.set(s.id, this.now() + 10000);
          if (finalized) this.d.eventStatus(s.event_id, 'completed');
        }
      } catch (e) {
        if (this.pause(e)) break;
        const code = e instanceof ServerError ? e.code : 'status_unavailable';
        await this.d.repo.updateSession(s.id, { last_error: code });
        this.sessionRetry.set(s.id, this.now() + backoff(4, e instanceof ServerError ? e.retryAfterS : undefined, this.d.random));
        this.d.connection('disconnected');
      }
    }
    all = (await Promise.all(sessions.map(s => this.d.repo.chunks(s.id)))).flat();
    const latest = await this.d.repo.sessions(this.d.owner);
    return all.some(c => ['pending','uploading','uploaded'].includes(c.status)) || latest.some(s => ['stopped','finalizing'].includes(s.status) && s.finalize_status !== 'interrupted');
  }
  async retryFailed(sessionId: string) {
    if ((await this.d.repo.session(sessionId))?.owner_uid !== this.d.owner) return;
    for (const c of await this.d.repo.chunks(sessionId)) if (c.status === 'failed_permanent' && !c.local_deleted)
      await this.d.repo.updateChunk(c.chunk_id, { status: 'pending', next_attempt_at: 0, last_error: null });
    this.notify(true);
  }
}

let service: UploadService | undefined;
let removeListeners: (() => void) | undefined;
let generation = 0;
let stoppedLane: Promise<void> = Promise.resolve();
export const uploadService = {
  async start(owner: string) {
    const token = ++generation;
    const previous = service; service = undefined;
    removeListeners?.(); removeListeners = undefined;
    stoppedLane = Promise.all([stoppedLane, previous?.stop()]).then(() => {});
    await stoppedLane;
    if (token !== generation) return;
    const url = useSettingsStore.getState().serverUrl;
    if (!url) return;
    const repo = await repositories();
    if (token !== generation) return;
    const client = authedClient(owner);
    if (!client) return;
    service = new UploadService({ repo, owner, client,
      deleteAfter: () => useSettingsStore.getState().deleteLocalAudioAfterTranscription,
      removeFile: deleteAudio, eventStatus: updateEventStatus,
      connection: status => useConnectionStore.getState().set({ status }) });
    const network = addNetworkStateListener(s => { if (s.isConnected !== false) service?.notify(true); });
    const app = AppState.addEventListener('change', s => { if (s === 'active') service?.notify(true); });
    const connection = useConnectionStore.subscribe((s, prev) => {
      if ((s.check !== prev.check && s.check) || (s.passExpiry !== prev.passExpiry && s.passExpiry)) service?.notify(true);
    });
    const auth = useAuthStore.subscribe((s, prev) => { if (s.user?.uid === owner && s.user !== prev.user) service?.notify(true); });
    const settings = useSettingsStore.subscribe((s, prev) => { if (s.deleteLocalAudioAfterTranscription !== prev.deleteLocalAudioAfterTranscription) service?.notify(); });
    removeListeners = () => { network.remove(); app.remove(); connection(); settings(); auth(); };
    service.start();
  },
  stop() {
    generation++;
    stoppedLane = Promise.all([stoppedLane, service?.stop()]).then(() => {});
    service = undefined; removeListeners?.(); removeListeners = undefined;
    return stoppedLane;
  },
  notify() { service?.notify(); },
  retryFailed(sessionId: string) { return service?.retryFailed(sessionId); }
};
