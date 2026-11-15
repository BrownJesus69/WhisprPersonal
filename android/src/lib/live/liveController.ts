import { TranslationAPI } from '../translation/api';
import { authedClient } from '../server/authedClient';
import { AppState } from 'react-native';
import { addNetworkStateListener } from 'expo-network';
import { repositories, type Repositories } from '../db/repositories';
import { credentials } from '../server/credentials';
import { createTokenManager } from '../server/tokenManager';
import { ServerError } from '../server/client';
import { auth } from '../firebase/auth';
import { useRecordingStore } from '../session/recordingStore';
import { onUploadProgress } from '../upload/uploadService';
import { useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { StreamClient } from './streamClient';
import { nativeSocket } from './socket';
import { LanguageOverride } from './languageOverride';
import type { LanguageMode } from './events';
import { useTranscriptStore } from './transcriptStore';

interface Entry { client?: StreamClient; refs: number; url?: string; owner?: string; starting?: boolean; pending?: boolean; generation?: number; synced?: boolean; override?: LanguageOverride }
const entries = new Map<string, Entry>();
let runtime = false;
let cleanup: (() => void) | undefined;
const recordingActive = (id: string) => {
  const r = useRecordingStore.getState();
  return r.sessionId === id && ['recording', 'paused', 'stopping', 'requesting_permission', 'error'].includes(r.phase);
};
function needed(id: string, e: Entry) { return e.refs > 0 || recordingActive(id); }
async function reconcile(id: string, e: Entry, refresh = false) {
  if (e.starting) { e.pending = true; return; }
  if (!needed(id, e)) { e.client?.stop(); entries.delete(id); return; }
  const owner = useAuthStore.getState().user?.uid;
  const url = useSettingsStore.getState().serverUrl;
  if (e.owner !== owner || e.url !== url) { e.client?.stop(); e.client = undefined; e.synced = false; }
  if (!owner) return;
  e.starting = true;
  const generation = e.generation;
  try {
    const repo = await repositories();
    const session = await repo.session(id);
    if (entries.get(id) !== e || e.generation !== generation || !needed(id, e) || session?.owner_uid !== owner || useAuthStore.getState().user?.uid !== owner) return;
    if (!e.client || refresh) await useTranscriptStore.getState().hydrate(repo, id);
    if (entries.get(id) !== e || e.generation !== generation || !needed(id, e)) return;
    if (!url) { useTranscriptStore.getState().setStatus(id, 'offline', 0); return; }
    if (e.synced) return;
    e.owner = owner; e.url = url;
    if (!e.client) {
      const tokens = createTokenManager(url);
      const sameOwner = () => useAuthStore.getState().user?.uid === owner && auth.current()?.uid === owner;
      e.override = makeOverride(repo, id, e, async mode => {
        if (!sameOwner()) throw new Error('Account changed');
        return tokens.client.post(`/api/v1/sessions/${encodeURIComponent(id)}/language`, { language: mode });
      });
      e.client = new StreamClient({ serverUrl: url, socket: nativeSocket,
        session: async () => sameOwner() ? repo.session(id) : null,
        getServerKey: credentials.getServerKey,
        getBearer: async () => {
          if (!sameOwner()) throw new ServerError(0, 'renew_required', 'Sign in to the recording account');
          const token = await tokens.getBearer();
          if (!sameOwner()) throw new ServerError(0, 'renew_required', 'Sign in to the recording account');
          return token;
        }, onAuthExpired: tokens.onAuthExpired,
        persist: async event => {
          if (event.type === 'chunk_audio_translated' && sameOwner()) {
            const client = authedClient(owner); if (!client) throw new Error('Offline');
            const rows = await new TranslationAPI(client).translations(id, 'en');
            if (!sameOwner()) return;
            await repo.storeTranslations(id, 'en', rows);
          }
          await repo.persistEvent(event);
        }, resetLastEventSeq: () => repo.resetLastEventSeq(id),
        apply: event => { if (sameOwner()) useTranscriptStore.getState().dispatch(event); },
        applyPartials: events => { if (sameOwner()) useTranscriptStore.getState().dispatchPartials(events); },
        status: (status, attempt) => {
          if (status === 'stopped' && useTranscriptStore.getState().sessions[id]?.model.finalized) e.synced = true;
          useTranscriptStore.getState().setStatus(id, status, attempt);
        },
        onOpen: () => { void e.override?.onReconnect(id).catch(() => {}); },
        onReset: () => useTranscriptStore.getState().reset(id)
      });
    }
    await e.client.start(id);
  } catch { useTranscriptStore.getState().setStatus(id, 'offline', 0); }
  finally {
    e.starting = false;
    if (entries.get(id) === e && (e.pending || !needed(id, e))) { e.pending = false; void reconcile(id, e, refresh); }
  }
}
function makeOverride(repo: Repositories, id: string, e: Entry, post: (mode: LanguageMode) => Promise<unknown>) {
  return new LanguageOverride({ repo,
    nextSequence: async () => {
      const r = useRecordingStore.getState();
      return r.sessionId === id && recordingActive(id) ? r.nextChunkSequence() : (await repo.session(id))?.next_sequence ?? 0;
    }, send: (_, mode) => e.client?.setLanguage(mode) ?? false,
    post: (_, mode) => post(mode), changed: (_, mode) => useTranscriptStore.getState().override(id, mode)
  });
}
function sync(refresh = false) {
  const r = useRecordingStore.getState();
  if (r.sessionId && recordingActive(r.sessionId) && !entries.has(r.sessionId)) entries.set(r.sessionId, { refs: 0 });
  for (const [id,e] of entries) void reconcile(id, e, refresh);
}
function restart() {
  for (const e of entries.values()) { e.generation = (e.generation ?? 0) + 1; e.client?.stop(); e.client = undefined; e.synced = false; e.override = undefined; }
  sync();
}
export const liveController = {
  startRuntime() {
    if (runtime) return;
    runtime = true;
    const recording = useRecordingStore.subscribe(() => sync());
    const settings = useSettingsStore.subscribe((s, prev) => { if (s.serverUrl !== prev.serverUrl) restart(); });
    const account = useAuthStore.subscribe((s, prev) => { if (s.user !== prev.user) restart(); });
    const credential = credentials.onChange(restart);
    const connection = useConnectionStore.subscribe((s, p) => { if (s.check !== p.check || s.passExpiry !== p.passExpiry) restart(); });
    const upload = onUploadProgress(id => { const e = entries.get(id); if (e) void reconcile(id, e, true); });
    const foreground = () => {
      for (const e of entries.values()) if (!e.synced) e.client?.reconnect();
      sync(true);
    };
    const app = AppState.addEventListener('change', state => { if (state === 'active') foreground(); });
    const network = addNetworkStateListener(state => { if (state.isConnected) foreground(); });
    cleanup = () => { recording(); settings(); account(); credential(); connection(); upload(); app.remove(); network.remove(); };
    sync();
  },
  stopRuntime() { cleanup?.(); cleanup = undefined; runtime = false; for (const e of entries.values()) e.client?.stop(); entries.clear(); },
  acquire(id: string) {
    const e = entries.get(id) ?? { refs: 0 }; e.refs++; entries.set(id, e); void reconcile(id, e);
    return () => { e.refs = Math.max(0, e.refs - 1); void reconcile(id, e); };
  },
  async setOverride(id: string, mode: LanguageMode) {
    const e = entries.get(id);
    const repo = await repositories();
    const session = await repo.session(id);
    if (!session || session.owner_uid !== useAuthStore.getState().user?.uid) throw new Error('Session unavailable');
    if (e?.override) return e.override.setOverride(id, mode);
    // No server URL configured: the same durable operation still works locally.
    const local = makeOverride(repo, id, e ?? { refs: 0 }, async () => { throw new Error('Offline'); });
    if (e) e.override = local;
    await local.setOverride(id, mode);
  }
};
