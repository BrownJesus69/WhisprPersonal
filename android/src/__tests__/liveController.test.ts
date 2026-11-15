import { liveController } from '../lib/live/liveController';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import * as repoModule from '../lib/db/repositories';
import * as socketModule from '../lib/live/socket';
import { useAuthStore } from '../state/authStore';
import { useSettingsStore } from '../state/settingsStore';
import { useRecordingStore } from '../lib/session/recordingStore';
import { useTranscriptStore } from '../lib/live/transcriptStore';
import { credentials } from '../lib/server/credentials';
import { FakeSocket } from './fakeSocket';
import { session } from './recordingFixtures';
import { finalEvent, hello, liveId } from './liveFixtures';
import { TranslationAPI } from '../lib/translation/api';
import { translation } from './translationFixtures';

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
async function setup(serverCreated = 1) {
  const repo = new MemoryRepositories(); await repo.putSession(session({ owner_uid: 'test-user', server_created: serverCreated }));
  jest.spyOn(repoModule, 'repositories').mockResolvedValue(repo);
  const sockets: FakeSocket[] = [];
  jest.spyOn(socketModule, 'nativeSocket').mockImplementation(() => { const s = new FakeSocket(); sockets.push(s); return s; });
  useAuthStore.getState().setUser({ uid: 'test-user', email: null, provider: 'password' });
  useSettingsStore.getState().set({ serverUrl: 'http://127.0.0.1:8770' });
  useRecordingStore.setState({ sessionId: null, phase: 'idle' });
  useTranscriptStore.setState({ sessions: {} });
  await credentials.setServerKey('test-key');
  liveController.startRuntime();
  return { repo, sockets };
}
beforeEach(() => jest.useFakeTimers());
afterEach(async () => { liveController.stopRuntime(); await flush(); jest.restoreAllMocks(); jest.clearAllTimers(); jest.useRealTimers(); });

test('screen release keeps socket during recording; stop after navigating away releases it', async () => {
  const t = await setup(); const release = liveController.acquire(liveId); await flush(); expect(t.sockets).toHaveLength(1);
  t.sockets[0].open(); t.sockets[0].message(hello()); await flush();
  useRecordingStore.setState({ sessionId: liveId, phase: 'recording' }); release(); await flush();
  expect(t.sockets[0].readyState).toBe(1);
  useRecordingStore.setState({ phase: 'stopped' }); await flush(); expect(t.sockets[0].readyState).toBe(3); expect(jest.getTimerCount()).toBe(0);
});
test('local-only session waits and starts once server_created changes; credentials restart', async () => {
  const t = await setup(0); const release = liveController.acquire(liveId); await flush(); expect(t.sockets).toHaveLength(0);
  await t.repo.updateSession(liveId, { server_created: 1 });
  useRecordingStore.setState({ sessionId: liveId, phase: 'recording' }); await flush(); expect(t.sockets).toHaveLength(1);
  await credentials.setServerKey('new-test-key'); await flush(); expect(t.sockets).toHaveLength(2); expect(t.sockets[0].readyState).toBe(3);
  release();
});
test('screen release during async initialization cannot leak socket/listeners', async () => {
  const t = await setup(); const release = liveController.acquire(liveId); release(); await flush();
  expect(t.sockets).toHaveLength(0); expect(jest.getTimerCount()).toBe(0);
});
test('controller override uses next chunker sequence even before pending writes reach SQLite', async () => {
  const t = await setup(); useRecordingStore.setState({ sessionId: liveId, phase: 'recording', nextChunkSequence: () => 5 }); await flush();
  t.sockets[0].open(); await liveController.setOverride(liveId, 'ta');
  expect((await t.repo.session(liveId))?.override_from_sequence).toBe(5);
  expect(t.sockets[0].sent).toContain('{"type":"set_language","language":"ta"}');
});
test('hydrated finalized session disconnects once caught up and stays stopped', async () => {
  const t = await setup(); await t.repo.persistEvent(finalEvent(1));
  await t.repo.persistEvent({ type: 'session_finalized', session_id: liveId, seq: 2, ts: 'now', data: { transcript_status: 'complete', missing_sequences: [], failed_sequences: [] } });
  const release = liveController.acquire(liveId); await flush(); expect(t.sockets).toHaveLength(1);
  t.sockets[0].open(); t.sockets[0].message(hello(2)); await flush();
  expect(t.sockets[0].readyState).toBe(3); expect(useTranscriptStore.getState().sessions[liveId].model.finals.size).toBe(1);
  useRecordingStore.setState({ dbfs: -20 }); await flush(); expect(t.sockets).toHaveLength(1); release();
});

test('audio translation stream event fetches English rows before advancing cursor; unknown events do not break stream', async () => {
  const t = await setup();
  const fetch = jest.spyOn(TranslationAPI.prototype,'translations').mockResolvedValue([translation({ source_lang: 'und', engine: 'groq-audio-translation' })]);
  const release = liveController.acquire(liveId); await flush();
  t.sockets[0].open(); t.sockets[0].message(hello()); await flush();
  t.sockets[0].message({ type: 'future_type', seq: 1, session_id: liveId, ts: 'now', data: {} });
  t.sockets[0].message({ type: 'chunk_audio_translated', seq: 2, session_id: liveId, ts: 'now', data: { sequence: 0, target_lang: 'en', engine: 'groq-audio-translation' } });
  await flush();
  expect(fetch).toHaveBeenCalledWith(liveId,'en');
  expect((await t.repo.translations(liveId,'en'))[0].source_lang).toBe('und');
  expect((await t.repo.session(liveId))?.last_event_seq).toBe(2);
  expect(await t.repo.transcript(liveId)).toEqual([]); release();
});
