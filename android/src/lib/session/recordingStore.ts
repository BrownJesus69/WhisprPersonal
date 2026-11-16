import { create } from 'zustand';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Chunker, type ChunkSpec } from '@/lib/audio/chunker';
import { levelDbfs } from '@/lib/audio/pcm';
import { sessionDirectory, writeChunk } from '@/lib/audio/chunkFiles';
import { requestRecordingPermissions, type Recorder } from '@/lib/audio/recorder';
import { chunkRow, repositories, type LocalSession, type Repositories } from '@/lib/db/repositories';
import { updateEventStatus } from '@/lib/firebase/events';
import { uploadService } from '@/lib/upload/uploadService';
import { useAuthStore } from '@/state/authStore';
import { useSettingsStore } from '@/state/settingsStore';
import type { EventModel } from '@/types/models';

export type RecordingPhase = 'idle' | 'requesting_permission' | 'ready' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error';
interface RecordingState {
  nextChunkSequence: () => number;
  phase: RecordingPhase; sessionId: string | null; elapsedMs: number; dbfs: number;
  message: string; warning: string; busy: boolean;
  start: (session: LocalSession, title: string, consent: boolean) => Promise<void>;
  pause: () => Promise<void>; resume: () => Promise<void>; stop: () => Promise<void>;
  interrupt: (reason: string) => Promise<void>;
}
interface Dependencies {
  repo: () => Promise<Repositories>; recorder: () => Recorder;
  permissions: typeof requestRecordingPermissions; disk: () => number; uid: () => string | undefined;
  write: typeof writeChunk; event: typeof updateEventStatus; notify: () => void;
  wait: (ms: number) => Promise<void>;
  master: (s: LocalSession) => { uri: string; directory: string; filename: string };
}
let attached: Recorder | undefined;
export function attachRecorder(recorder: Recorder) { attached = recorder; }

function saveFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown save error';
  const safe = message
    // Remove quoted paths (including spaces), then unquoted URIs and paths.
    .replace(/["'](?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|[\w.-]+[\\/])[^"']*["']/gi, '[path]')
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|[a-z]:[\\/]|\\\\|\/|\.{1,2}[\\/]|\b[\w.-]+[\\/])[^\s"'<>]*/gi, '[path]')
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return `chunk_save_failed: ${safe || 'Unknown save error'}`.slice(0, 200);
}

export function createRecordingStore(d: Dependencies) {
  let chunker: Chunker | undefined;
  let writes = Promise.resolve();
  let live: LocalSession | undefined;
  let writeFailed = false;
  let writeError: unknown;
  let nativeActive = false;
  // True once the native recorder (which writes the master WAV) started for the current run.
  let masterStarted = false;
  let lastMeter = 0;
  return create<RecordingState>()((set, get) => {
    const failure = async (error: unknown, session = live) => {
      set({ phase: 'error', busy: false, message: masterStarted
        ? 'Saving audio on this phone failed. The full recording is still being kept. Tap Stop, then reopen the app to recover it.'
        : 'Recording could not start, so nothing was recorded. Try again.' });
      try {
        if (session) await (await d.repo()).updateSession(session.id, { last_error: saveFailureReason(error) });
      } catch { /* Keep the recovery message even when the database is unavailable. */ }
    };
    const enqueue = (spec: ChunkSpec) => {
      const session = live!;
      writes = writes.then(async () => {
        if (writeFailed) return;
        let chunk: ReturnType<typeof chunkRow> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            // Retain the file and row across insert retries; a successful insert is never retried.
            chunk ??= chunkRow(session.id, spec, await d.write(session.id, spec));
            const repo = await d.repo();
            if (attempt > 0) {
              // A native connection can reject after COMMIT (for example, while closing).
              const stored = (await repo.chunks(session.id)).find(row => row.sequence === spec.sequence);
              if (stored) {
                if (stored.chunk_id !== chunk.chunk_id) throw new Error('Chunk sequence already stored');
                break;
              }
            }
            await repo.insertChunk(chunk, { next_sequence: spec.sequence + 1, time_ms: spec.endMs });
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            await d.wait(attempt === 0 ? 250 : 1000);
          }
        }
        d.notify();
      }).catch(async error => { writeFailed = true; writeError = error; await failure(error, session); });
    };
    const flush = async (reason: 'pause' | 'stop') => {
      const tail = chunker?.flush(reason); if (tail) enqueue(tail);
      await writes;
      if (writeFailed) throw writeError;
      if (live && chunker) await (await d.repo()).updateSession(live.id, { next_sequence: chunker.nextSequence, time_ms: chunker.timeMs });
    };
    return {
      nextChunkSequence: () => chunker?.nextSequence ?? 0,
      phase: 'idle', sessionId: null, elapsedMs: 0, dbfs: -96, message: '', warning: '', busy: false,
      async start(session, title, consent) {
        if (get().busy || nativeActive || ['recording','paused','stopping'].includes(get().phase)) return;
        set({ message: '', warning: '' });
        if (!d.uid() || d.uid() !== session.owner_uid) { set({ message: 'Sign in to record this session.' }); return; }
        if (!consent) { set({ message: 'Confirm everyone’s recording consent first.' }); return; }
        if (!['paused','stopped'].includes(session.status) || session.finalize_status === 'finalized' || session.server_created && session.finalize_status !== 'interrupted' && session.status === 'stopped') {
          set({ message: 'This session is closed. Start a new session from the event.' }); return;
        }
        masterStarted = false; set({ phase: 'requesting_permission', busy: true });
        try {
          const permission = await d.permissions();
          if (!permission.microphone) { set({ phase: 'ready', busy: false, message: 'Microphone permission is required. Enable it in Android settings if denied.' }); return; }
          const disk = d.disk();
          if (!Number.isFinite(disk) || disk < 500 * 1024 * 1024) { set({ phase: 'ready', busy: false, message: 'At least 500 MB of free phone storage is required.' }); return; }
          if (d.uid() !== session.owner_uid) throw new Error('Account changed');
          set({ phase: 'ready', warning: [!permission.notifications ? 'Notifications are disabled. Allow them to see the recording notification.' : '', disk < 2 * 1024 ** 3 ? 'Less than 2 GB free. Check storage during long events.' : ''].filter(Boolean).join(' ') });
          const master = d.master(session);
          live = { ...session, master_uri: master.uri, consent_at: new Date().toISOString() };
          chunker = new Chunker({ sampleRate: 16000, chunkMs: session.chunk_ms, overlapMs: session.overlap_ms, startSequence: session.next_sequence, startTimeMs: session.time_ms });
          writes = Promise.resolve(); writeFailed = false; writeError = undefined; masterStarted = false;
          await (await d.repo()).updateSession(session.id, { status: 'recording', master_uri: master.uri, consent_at: live.consent_at, finalize_status: null, last_error: null });
          set({ sessionId: session.id, elapsedMs: session.time_ms });
          nativeActive = true;
          await d.recorder().start({ ...master, title, onPcm: pcm => {
            if (writeFailed) return;
            for (const spec of chunker!.push(pcm)) enqueue(spec);
            if (Date.now() - lastMeter >= 100) {
              lastMeter = Date.now();
              const count = Math.floor(pcm.length / 2);
              const samples = new Int16Array(count);
              const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
              for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true);
              set({ elapsedMs: chunker!.timeMs, dbfs: levelDbfs(samples) });
            }
          }, onInterrupted: reason => { void get().interrupt(reason); } });
          masterStarted = true;
          // An audio-focus interruption may have happened while native Start resolved.
          if (!['paused','error'].includes(get().phase)) set({ phase: 'recording', busy: false });
          d.event(session.event_id, 'active');
        } catch (error) { await failure(error, session); }
      },
      async pause() {
        if (get().phase !== 'recording' || get().busy) return;
        set({ busy: true });
        try { await d.recorder().pause(); await flush('pause'); await (await d.repo()).updateSession(live!.id, { status: 'paused' }); set({ phase: 'paused', busy: false, dbfs: -96, elapsedMs: chunker!.timeMs }); }
        catch (error) { await failure(error); }
      },
      async resume() {
        if (get().phase !== 'paused' || get().busy) return;
        if (d.uid() !== live?.owner_uid) { set({ message: 'Sign in to the recording account before resuming.' }); return; }
        if (d.disk() < 500 * 1024 * 1024) { set({ message: 'At least 500 MB free storage is required to resume.' }); return; }
        set({ busy: true });
        try { await d.recorder().resume(); await (await d.repo()).updateSession(live!.id, { status: 'recording' }); set({ phase: 'recording', busy: false, message: '' }); }
        catch (error) { await failure(error); }
      },
      async stop() {
        if (!live || get().busy || !['recording','paused','error'].includes(get().phase)) return;
        set({ phase: 'stopping', busy: true });
        try {
          await d.recorder().stop(); nativeActive = false; await flush('stop');
          await (await d.repo()).updateSession(live.id, { status: 'stopped', expected_chunk_count: chunker!.nextSequence });
          d.event(live.event_id, 'processing'); d.notify();
          set({ phase: 'stopped', busy: false, dbfs: -96, elapsedMs: chunker!.timeMs });
        } catch (error) { await failure(error); }
      },
      async interrupt(reason) {
        if (!live || !['recording','ready','requesting_permission'].includes(get().phase)) return;
        set({ phase: 'paused', busy: true, message: `Recording paused: ${reason}. Tap Resume.`, dbfs: -96 });
        try { await flush('pause'); await (await d.repo()).updateSession(live.id, { status: 'paused' }); set({ busy: false }); }
        catch (error) { await failure(error); }
      }
    };
  });
}
export const useRecordingStore = createRecordingStore({ repo: repositories,
  recorder: () => { if (!attached) throw new Error('Recorder unavailable'); return attached; },
  permissions: requestRecordingPermissions, disk: () => Paths.availableDiskSpace,
  uid: () => useAuthStore.getState().user?.uid, write: writeChunk, event: updateEventStatus,
  notify: uploadService.notify,
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  master: s => {
    const dir = sessionDirectory(s.id); dir.create({ intermediates: true, idempotent: true });
    // A fresh master per recovered run preserves the previous master and its clock origin.
    const filename = s.time_ms || new File(dir, 'master.wav').exists ? `master_${s.time_ms}_${randomUUID().replace(/-/g, '')}.wav` : 'master.wav';
    return { directory: dir.uri, filename, uri: new File(dir, filename).uri };
  }
});

export async function createLocalSession(event: EventModel): Promise<LocalSession> {
  const owner = useAuthStore.getState().user?.uid;
  if (!owner || owner !== event.ownerId) throw new Error('Sign in to create a session');
  const settings = useSettingsStore.getState();
  const id = `ses_${randomUUID().replace(/-/g, '').slice(0,24)}`;
  const now = new Date().toISOString();
  // SQL has no ready status: paused + no consent represents an unstarted local session.
  const session: LocalSession = { id, owner_uid: owner, event_id: event.id, status: 'paused',
    language_mode: event.languageMode, expected_languages: event.languages, chunk_ms: settings.chunkSeconds * 1000,
    overlap_ms: settings.overlapMs, next_sequence: 0, time_ms: 0, master_uri: new File(sessionDirectory(id), 'master.wav').uri,
    server_created: 0, expected_chunk_count: null, finalize_status: null, consent_at: null,
    created_at: now, updated_at: now, last_error: null };
  await (await repositories()).putSession(session);
  return session;
}
