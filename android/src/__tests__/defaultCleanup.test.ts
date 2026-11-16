import { requestDefaultCleanup } from '@/features/speak/defaultCleanup';
import { repositories } from '@/lib/db/repositories';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { getEvent } from '@/lib/firebase/events';
import { AIAPI } from '@/lib/ai/api';
import { aiRuntime } from '@/lib/ai/runtime';
import { useSettingsStore, defaults } from '@/state/settingsStore';
import { session } from './recordingFixtures';
import { aiStatus } from './aiFixtures';
jest.mock('@/lib/db/repositories', () => ({ ...jest.requireActual('@/lib/db/repositories'), repositories: jest.fn() }));
jest.mock('@/lib/firebase/events', () => ({ getEvent: jest.fn() }));
jest.mock('@/lib/server/authedClient', () => ({ authedClient: () => ({}) }));
jest.mock('@/lib/ai/runtime', () => ({ aiRuntime: { get: jest.fn() } }));
const submit = jest.fn(async () => ({}));
let repo: MemoryRepositories;
beforeEach(async () => {
  repo = new MemoryRepositories(); jest.mocked(repositories).mockResolvedValue(repo);
  await repo.putSession(session({ status: 'finalized' }));
  useSettingsStore.setState({ ...defaults, serverUrl: 'http://192.168.1.20:8000' });
  jest.mocked(getEvent).mockResolvedValue({ privacyMode: 'cloud_ai' } as never);
  jest.mocked(aiRuntime.get).mockReturnValue({ submit } as never);
  jest.spyOn(AIAPI.prototype, 'status').mockResolvedValue(aiStatus(true));
});
afterEach(() => jest.restoreAllMocks());
test('original never requests AI; unfinished and other-owner sessions are also untouched', async () => {
  expect(await requestDefaultCleanup('owner', session().id, 'none')).toBe('original');
  expect(await requestDefaultCleanup('other', session().id, 'polished')).toBe('original');
  await repo.updateSession(session().id, { status: 'finalizing' });
  expect(await requestDefaultCleanup('owner', session().id, 'polished')).toBe('original');
  expect(submit).not.toHaveBeenCalled(); expect(AIAPI.prototype.status).not.toHaveBeenCalled();
});
test('enabled default submits through the existing runner without changing original rows', async () => {
  expect(await requestDefaultCleanup('owner', session().id, 'conservative')).toBe('available');
  expect(submit).toHaveBeenCalledWith({ event_id: 'event-1', session_ids: [session().id], level: 'conservative' });
});
test('actual event privacy and provider availability fail closed', async () => {
  jest.mocked(getEvent).mockResolvedValue({ privacyMode: 'local_only' } as never);
  expect(await requestDefaultCleanup('owner', session().id, 'polished')).toBe('not_configured');
  jest.mocked(getEvent).mockResolvedValue({ privacyMode: 'cloud_ai' } as never);
  jest.mocked(AIAPI.prototype.status).mockResolvedValue(aiStatus(false));
  expect(await requestDefaultCleanup('owner', session().id, 'polished')).toBe('not_configured');
  expect(submit).not.toHaveBeenCalled();
});
test('accepted cleanup jobs are never automatically submitted twice', async () => {
  await repo.putAIJob({ job_id: 'cleanup', kind: 'cleanup', status: 'queued', event_id: 'event-1', owner_uid: 'owner', session_ids: [session().id], error_code: null, created_at: '', updated_at: '' });
  expect(await requestDefaultCleanup('owner', session().id, 'polished')).toBe('available'); expect(submit).not.toHaveBeenCalled();
});
