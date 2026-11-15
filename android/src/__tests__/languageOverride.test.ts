import { LanguageOverride, chunkLanguage } from '../lib/live/languageOverride';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { session } from './recordingFixtures';
async function setup() {
  const repo = new MemoryRepositories(); await repo.putSession(session());
  const order: string[] = [];
  const original = repo.setLanguageOverride.bind(repo);
  jest.spyOn(repo, 'setLanguageOverride').mockImplementation(async (...args) => { await original(...args); order.push('persist'); });
  const send = jest.fn(() => { order.push('ws'); return true; });
  const post = jest.fn(async () => { order.push('http'); });
  const changed = jest.fn();
  const manager = new LanguageOverride({ repo, nextSequence: () => 3, send, post, changed });
  return { repo, manager, order, send, post, changed };
}
test('persist before WS; fields only from boundary; Auto stops fields', async () => {
  const t = await setup(); await t.manager.setOverride(session().id, 'ta');
  expect(t.order).toEqual(['persist', 'ws']); expect(t.post).not.toHaveBeenCalled();
  const saved = (await t.repo.session(session().id))!;
  expect(saved).toMatchObject({ language_override: 'ta', override_from_sequence: 3 });
  expect(chunkLanguage(saved, 2)).toBeUndefined(); expect(chunkLanguage(saved, 3)).toBe('ta'); expect(chunkLanguage(saved, 99)).toBe('ta');
  await t.manager.setOverride(session().id, 'auto'); expect(chunkLanguage((await t.repo.session(session().id))!, 99)).toBeUndefined();
  expect(t.send).toHaveBeenLastCalledWith(session().id, 'auto');
});
test('HTTP fallback; local-only if unreachable; durable retry on reconnect', async () => {
  const t = await setup(); t.send.mockReturnValue(false); t.post.mockRejectedValue(new Error('Offline'));
  await t.manager.setOverride(session().id, 'kn'); expect(t.order).toEqual(['persist']);
  expect(t.post).toHaveBeenCalledWith(session().id, 'kn'); expect((await t.repo.session(session().id))?.language_override).toBe('kn');
  t.post.mockResolvedValue(); await t.manager.onReconnect(session().id); expect(t.post).toHaveBeenCalledTimes(2);
  t.send.mockReturnValue(true); await t.manager.onReconnect(session().id); expect(t.post).toHaveBeenCalledTimes(2);
});
test('409 ignored, auto intention retried after restart, HTTP success follows WS false', async () => {
  const t = await setup(); t.send.mockReturnValue(false); t.post.mockRejectedValue({ status: 409, code: 'session_finalized' });
  await expect(t.manager.setOverride(session().id, 'auto')).resolves.toBeUndefined();
  t.post.mockResolvedValue(); await t.manager.onReconnect(session().id); expect(t.post).toHaveBeenLastCalledWith(session().id, 'auto');
  expect((await t.repo.session(session().id))?.override_from_sequence).toBe(3);
});
test('rapid selections serialize; persistence failure prevents any transport', async () => {
  const t = await setup(); await Promise.all([t.manager.setOverride(session().id, 'kn'), t.manager.setOverride(session().id, 'hi')]);
  expect((await t.repo.session(session().id))?.language_override).toBe('hi');
  t.send.mockClear(); jest.spyOn(t.repo, 'setLanguageOverride').mockRejectedValue(new Error('Disk full'));
  await expect(t.manager.setOverride(session().id, 'ta')).rejects.toThrow('Disk full'); expect(t.send).not.toHaveBeenCalled(); expect(t.post).not.toHaveBeenCalled();
});
