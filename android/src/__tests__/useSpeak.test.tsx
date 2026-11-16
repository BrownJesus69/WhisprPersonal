import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { t } from '@/i18n';
import { useSpeak, draftKey } from '@/features/speak/useSpeak';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { repositories, transcriptRow } from '@/lib/db/repositories';
import { createLocalSession, useRecordingStore } from '@/lib/session/recordingStore';
import { createEvent, getEvent } from '@/lib/firebase/events';
import { deleteSession } from '@/lib/session/deleteSession';
import { useAuthStore } from '@/state/authStore';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useTranscriptStore } from '@/lib/live/transcriptStore';
import { kv } from '@/lib/storage/kv';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
jest.mock('@/lib/db/repositories', () => ({ ...jest.requireActual('@/lib/db/repositories'), repositories: jest.fn() }));
jest.mock('@/lib/session/recordingStore', () => {
  const { create } = jest.requireActual('zustand');
  return { createLocalSession: jest.fn(), useRecordingStore: create(() => ({ phase: 'idle', sessionId: null, message: '', warning: '', busy: false, dbfs: -96, elapsedMs: 0, start: jest.fn(), stop: jest.fn() })) };
});
jest.mock('@/lib/firebase/events', () => ({ createEvent: jest.fn(async () => 'speak-event'), getEvent: jest.fn(async () => null), updateEventStatus: jest.fn() }));
jest.mock('@/lib/session/deleteSession', () => ({ deleteSession: jest.fn(async () => {}) }));
jest.mock('@/lib/server/authedClient', () => ({ authedClient: () => null }));
jest.mock('@/lib/live/liveController', () => ({ liveController: { acquire: jest.fn(() => jest.fn()), startRuntime: jest.fn(), stopRuntime: jest.fn() } }));
jest.mock('@/lib/upload/uploadService', () => ({ uploadService: { stop: jest.fn(async () => {}), start: jest.fn(async () => {}), notify: jest.fn() } }));
jest.mock('@/lib/ai/runtime', () => ({ aiRuntime: { stop: jest.fn(async () => {}), start: jest.fn(async () => {}) } }));
let repo: MemoryRepositories;
const id = session().id;
async function tick(ms = 1500) { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  jest.useFakeTimers();
  repo = new MemoryRepositories(); jest.mocked(repositories).mockResolvedValue(repo);
  useAuthStore.getState().setUser({ uid: 'owner', email: null, provider: 'password' });
  useSettingsStore.setState(defaults); useConnectionStore.setState({ status: 'connected' }); useTranscriptStore.setState({ sessions: {} });
  useRecordingStore.setState({ phase: 'idle', sessionId: null, message: '', warning: '', busy: false });
  jest.mocked(createLocalSession).mockImplementation(async event => { const row = session({ status: 'paused', consent_at: null, event_id: event.id, language_mode: event.languageMode }); await repo.putSession(row); return row; });
  jest.mocked(useRecordingStore.getState().start).mockImplementation(async current => { await repo.updateSession(current.id, { status: 'recording', consent_at: 'now' }); useRecordingStore.setState({ phase: 'recording', sessionId: current.id }); });
  jest.mocked(useRecordingStore.getState().stop).mockImplementation(async () => { useRecordingStore.setState({ phase: 'stopping' }); await repo.updateSession(id, { status: 'stopped' }); useRecordingStore.setState({ phase: 'stopped' }); });
});
afterEach(() => { jest.useRealTimers(); });
test('start, listening, immediate stopping, processing and finalized text in sequence order', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const hook = await renderHook(useSpeak);
  expect(hook.result.current.state).toBe('idle');
  await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.state).toBe('listening');
  expect(announce).toHaveBeenCalledWith(t('recordingAnnouncement'));
  announce.mockClear();
  await act(async () => { useRecordingStore.setState({ elapsedMs: 5000, dbfs: -20 }); });
  expect(announce).not.toHaveBeenCalled();
  expect(createEvent).toHaveBeenCalledTimes(1);
  expect(useRecordingStore.getState().start).toHaveBeenCalledWith(expect.objectContaining({ language_mode: 'auto' }), 'Speak', true);
  await act(async () => { await hook.result.current.stop(); });
  expect(hook.result.current.state).toBe('processing');
  expect(announce).toHaveBeenCalledWith(t('processingAnnouncement'));
  await repo.upsertTranscript(transcriptRow(id, finalData({ sequence: 1, raw_text: 'second' })));
  await repo.upsertTranscript(transcriptRow(id, finalData({ sequence: 0, raw_text: 'first' })));
  await repo.updateSession(id, { status: 'finalized' }); await tick();
  expect(hook.result.current.state).toBe('complete'); expect(hook.result.current.draft).toBe('first second');
  expect(announce).toHaveBeenCalledWith(t('readyAnnouncement'));
  announce.mockRestore();
});

test('leaving Speak while recording does not call Stop', async () => {
  const hook = await renderHook(useSpeak);
  await act(async () => { await hook.result.current.start(); });
  await hook.unmount();
  expect(useRecordingStore.getState().stop).not.toHaveBeenCalled();
  expect(useRecordingStore.getState().phase).toBe('recording');
});

test('next Speak start removes finalized Speak recordings when retention is off', async () => {
  useSettingsStore.setState({ keepTranscripts: false, speakEventIds: { owner: 'speak-event' } });
  await repo.putSession(session({ id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', event_id: 'speak-event', status: 'finalized' }));
  const hook = await renderHook(useSpeak);
  await act(async () => { await hook.result.current.start(); });
  expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaa' }));
  expect(useRecordingStore.getState().start).toHaveBeenCalled();
});
test('retention failure reports a notice and still allows a new recording', async () => {
  useSettingsStore.setState({ keepTranscripts: false, speakEventIds: { owner: 'speak-event' } });
  await repo.putSession(session({ id: 'ses_aaaaaaaaaaaaaaaaaaaaaaaa', event_id: 'speak-event', status: 'finalized' }));
  jest.mocked(deleteSession).mockRejectedValueOnce(new Error('busy'));
  const hook = await renderHook(useSpeak);
  await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.retentionNotice).toBeTruthy(); expect(hook.result.current.state).toBe('listening');
});
test('shows starting and stopping while native promises are pending', async () => {
  let release!: () => void;
  const original = useRecordingStore.getState().start;
  jest.mocked(original).mockImplementationOnce(() => new Promise(resolve => { release = () => { useRecordingStore.setState({ phase: 'recording', sessionId: id }); resolve(); }; }));
  const hook = await renderHook(useSpeak);
  let pending!: Promise<void>;
  await act(async () => { pending = hook.result.current.start(); });
  expect(hook.result.current.state).toBe('starting');
  await act(async () => { release(); await pending; });
  jest.mocked(useRecordingStore.getState().stop).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { pending = hook.result.current.stop(); });
  expect(hook.result.current.state).toBe('stopping');
  await act(async () => { release(); await pending; });
  expect(hook.result.current.state).toBe('processing');
});
test('permission denial remains actionable after polling', async () => {
  jest.mocked(useRecordingStore.getState().start).mockImplementationOnce(async () => { useRecordingStore.setState({ phase: 'ready', message: 'Microphone permission is required.' }); });
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.state).toBe('permission_denied'); await tick(); expect(hook.result.current.state).toBe('permission_denied');
});
test('disconnected while processing, slow after 60 seconds without new rows', async () => {
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); }); await act(async () => { await hook.result.current.stop(); });
  await act(async () => { useConnectionStore.setState({ status: 'disconnected' }); });
  expect(hook.result.current.disconnected).toBe(true);
  await tick(); await tick(60000); expect(hook.result.current.state).toBe('slow');
  await repo.upsertTranscript(transcriptRow(id, finalData())); await tick(); expect(hook.result.current.state).toBe('processing');
});
test('restores interrupted session and finishes through the existing upload queue', async () => {
  useSettingsStore.setState({ speakEventId: 'speak-event', speakEventOwner: 'owner' });
  await repo.putSession(session({ event_id: 'speak-event', status: 'stopped', finalize_status: 'interrupted' }));
  const hook = await renderHook(useSpeak); await tick();
  expect(hook.result.current.interrupted).toBe(true);
  await act(async () => { await hook.result.current.finish(); });
  expect(await repo.session(id)).toMatchObject({ status: 'stopped', finalize_status: null });
});
test('Cancel Keep stops; Discard stops before calling deleteSession', async () => {
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); });
  await act(async () => { await hook.result.current.stop(); }); expect(deleteSession).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.remove(); });
  expect(deleteSession).toHaveBeenCalledWith(expect.objectContaining({ id, phase: 'stopped' })); expect(hook.result.current.state).toBe('idle');
});
test('drafts persist per session and never write transcript rows, including cleanup drafts', async () => {
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); }); await act(async () => { await hook.result.current.stop(); });
  await repo.upsertTranscript(transcriptRow(id, finalData({ raw_text: 'raw text' }))); await repo.storePolished(id, [{ sequence: 0, polished_text: 'Clean text.', polished_level: 'conservative', polish_error: null }], await repo.transcript(id)); await repo.updateSession(id, { status: 'finalized' }); await tick();
  const write = jest.spyOn(repo, 'upsertTranscript');
  await act(async () => { hook.result.current.editDraft('my draft'); }); await tick(350);
  expect(await kv.getItem(draftKey('owner', id))).toBe('my draft'); expect(write).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.changeCleaned(true); }); expect(hook.result.current.draft).toBe('Clean text.');
  await act(async () => { await hook.result.current.changeCleaned(false); }); expect(hook.result.current.draft).toBe('my draft');
  expect((await repo.transcript(id))[0].raw_text).toBe('raw text');
});
test('recreates missing event and does not reuse another account event', async () => {
  useSettingsStore.setState({ speakEventId: 'missing', speakEventOwner: 'owner', defaultLanguageMode: 'ta' });
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); });
  expect(getEvent).toHaveBeenCalledWith('missing', 'owner'); expect(createEvent).toHaveBeenCalledTimes(1);
  expect(createLocalSession).toHaveBeenCalledWith(expect.objectContaining({ languageMode: 'ta' }));
});

test('keeps each account Speak event id when switching accounts', async () => {
  useSettingsStore.setState({ speakEventIds: { owner: 'owner-event', other: 'other-event' }, speakEventId: 'other-event', speakEventOwner: 'other' });
  const hook = await renderHook(useSpeak);
  await act(async () => { await hook.result.current.start(); });
  expect(getEvent).toHaveBeenCalledWith('owner-event', 'owner');
  expect(useSettingsStore.getState().speakEventIds.other).toBe('other-event');
});
test('flushes edits on unmount and restores draft when an unfinished session completes', async () => {
  const hook = await renderHook(useSpeak); await act(async () => { await hook.result.current.start(); }); await act(async () => { await hook.result.current.stop(); });
  await repo.upsertTranscript(transcriptRow(id, finalData({ raw_text: 'saved original' }))); await repo.updateSession(id, { status: 'finalized' }); await tick();
  await act(async () => { hook.result.current.editDraft('retained edit'); });
  await hook.unmount();
  expect(await kv.getItem(draftKey('owner', id))).toBe('retained edit');
  await repo.updateSession(id, { status: 'finalizing' });
  const restored = await renderHook(useSpeak); await tick();
  await repo.updateSession(id, { status: 'finalized' }); await tick();
  expect(restored.result.current.draft).toBe('retained edit');
});
