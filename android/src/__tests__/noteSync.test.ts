import { NoteSyncEngine, type NoteRemote } from '../lib/notes/noteSync';
import { notesApi } from '../lib/notes/notes';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { note, remote } from './noteFixtures';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function deferred() { let resolve!: () => void, reject!: (error: unknown) => void; const promise = new Promise<void>((yes,no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const repo = new MemoryRepositories(), write = deferred();
  const cloud = { push: jest.fn<ReturnType<NoteRemote['push']>, Parameters<NoteRemote['push']>>(() => write.promise), fetchFromServer: jest.fn<ReturnType<NoteRemote['fetchFromServer']>, Parameters<NoteRemote['fetchFromServer']>>(async () => null), subscribe: jest.fn(() => jest.fn()) };
  const engine = new NoteSyncEngine({ repo, remote: cloud, owner: 'owner', deviceId: 'my-device', now: () => 1000, random: () => 1 });
  return { repo, write, cloud, engine, api: notesApi(repo,'owner',() => {}) };
}
test('offline never-settling writes leave tick free, deduplicate per revision and ack after connectivity', async () => {
  const { repo,engine,write,cloud } = setup(); await repo.putNote(note());
  await engine.tick(); await engine.tick(); expect(cloud.push).toHaveBeenCalledTimes(1);
  expect((await repo.note(note().id))?.sync_state).toBe('pending');
  write.resolve(); await flush(); expect(await repo.note(note().id)).toMatchObject({ sync_state: 'synced', synced_revision: 1 });
});
test('late ack advances metadata but cannot mark a newer edit synced or replace a tombstone', async () => {
  const { repo,engine,write,api } = setup(); await repo.putNote(note()); await engine.tick();
  await api.editNote(note().id,{ text: 'New text' }); write.resolve(); await flush();
  expect(await repo.note(note().id)).toMatchObject({ text: 'New text', revision: 2, synced_revision: 1, sync_state: 'pending' });
  await api.deleteNote(note().id); await engine.pull('event-1',[{ note: remote({ revision: 1 }), pending: false }]);
  expect(await repo.note(note().id)).toMatchObject({ deleted: 1, text: '', revision: 3, sync_state: 'pending' });
});
test.each(['conflict','acked','failed'] as const)('permission denied fetch resolves to %s', async outcome => {
  const { repo,engine,write,cloud } = setup(); await repo.putNote(note());
  cloud.fetchFromServer.mockResolvedValue(outcome === 'failed' ? null : remote({ deviceId: outcome === 'acked' ? 'my-device' : 'other-device' }));
  await engine.tick(); write.reject({ code: 'firestore/permission-denied' }); await flush();
  expect((await repo.note(note().id))?.sync_state).toBe(outcome === 'acked' ? 'synced' : outcome);
  expect((await repo.note(note().id))?.text).toBe('Local note');
});
test.each(['firestore/invalid-argument','firestore/failed-precondition'])('permanent error %s retains local text', async code => {
  const { repo,engine,write } = setup(); await repo.putNote(note()); await engine.tick(); write.reject({ code }); await flush();
  expect(await repo.note(note().id)).toMatchObject({ sync_state: 'failed', text: 'Local note', last_error: code.replace('firestore/','') });
});
test.each(['firestore/unavailable','firestore/deadline-exceeded','unknown'])('transient %s backs off durably', async code => {
  const { repo,engine,write,cloud } = setup(); await repo.putNote(note()); await engine.tick(); write.reject({ code }); await flush();
  expect(await repo.note(note().id)).toMatchObject({ sync_state: 'pending', attempts: 1, next_attempt_at: 2000 });
  await engine.tick(); expect(cloud.push).toHaveBeenCalledTimes(1);
});
test('fetch failure backs off; late rejection does not change edited text or state', async () => {
  const { repo,engine,write,cloud,api } = setup(); await repo.putNote(note()); cloud.fetchFromServer.mockRejectedValue(new Error('offline'));
  await engine.tick(); write.reject({ code: 'firestore/permission-denied' }); await flush(); expect((await repo.note(note().id))?.attempts).toBe(1);
  const fresh = setup(); await fresh.repo.putNote(note()); await fresh.engine.tick();
  await fresh.api.editNote(note().id,{ text: 'edited' }); fresh.write.reject({ code: 'firestore/permission-denied' }); await flush();
  expect(await fresh.repo.note(note().id)).toMatchObject({ sync_state: 'pending', text: 'edited', revision: 2 });
  await api.retryFailed(note().id);
});
test('restart re-pushes pending row; stopped old worker cannot change state', async () => {
  const { repo,engine,write,cloud } = setup(); await repo.putNote(note()); await engine.tick(); engine.stop();
  const next = new NoteSyncEngine({ repo, remote: cloud, owner: 'owner', deviceId: 'my-device' });
  await next.tick(); expect(cloud.push).toHaveBeenCalledTimes(2);
  write.resolve(); await flush(); expect((await repo.note(note().id))?.sync_state).toBe('synced');
});
test('pull skips pending echoes/wrong owner, preserves conflicts, and imports tombstones', async () => {
  const { repo,engine,api } = setup(); await repo.putNote(note());
  await engine.pull('event-1',[{ note: remote(), pending: true },{ note: remote({ ownerId: 'other' }), pending: false }]);
  expect((await repo.note(note().id))?.sync_state).toBe('pending');
  await engine.pull('event-1',[{ note: remote(), pending: false }]);
  await api.editNote(note().id,{ text: 'edited during conflict' });
  expect(await repo.note(note().id)).toMatchObject({ sync_state: 'conflict', text: 'edited during conflict', revision: 2 });
  await api.keepMine(note().id); expect(await repo.note(note().id)).toMatchObject({ sync_state: 'pending', revision: 3, synced_revision: 2, remote_json: null });
  await engine.pull('event-1',[{ note: remote({ revision: 4, deleted: true, text: '' }), pending: false }]);
  await api.useCloud(note().id); expect(await repo.note(note().id)).toMatchObject({ deleted: 1, text: '', sync_state: 'synced', revision: 4 });
  await engine.pull('event-1',[{ note: remote({ revision: 3 }), pending: false }]); expect((await repo.note(note().id))?.deleted).toBe(1);
  await engine.pull('event-1',[{ note: remote({ id: 'new-tombstone', deleted: true, text: '' }), pending: false }]); expect((await repo.note('new-tombstone'))?.deleted).toBe(1);
});
test('pull own ack cannot mark newer revision synced, clean remote applies', async () => {
  const { repo,engine } = setup(); await repo.putNote(note({ revision: 3 }));
  await engine.pull('event-1',[{ note: remote({ deviceId: 'my-device' }), pending: false }]);
  expect(await repo.note(note().id)).toMatchObject({ revision: 3, synced_revision: 2, sync_state: 'pending' });
  await engine.pull('event-1',[{ note: remote({ deviceId: 'my-device', revision: 3 }), pending: false }]);
  await engine.pull('event-1',[{ note: remote({ revision: 4, text: 'New cloud' }), pending: false }]);
  expect(await repo.note(note().id)).toMatchObject({ text: 'New cloud', revision: 4, synced_revision: 4, sync_state: 'synced' });
});
test('late ack preserves conflict and remote metadata at a newer version', async () => {
  const { repo,engine,write } = setup(); await repo.putNote(note()); await engine.tick();
  await engine.pull('event-1',[{ note: remote({ revision: 3 }), pending: false }]);
  write.resolve(); await flush(); expect(await repo.note(note().id)).toMatchObject({ sync_state: 'conflict', text: 'Local note' });
});
test('owner isolation and 50 notes per pass', async () => {
  const { repo,engine,cloud } = setup();
  for (let i = 0; i < 55; i++) await repo.putNote(note({ id: String(i) }));
  await repo.putNote(note({ id: 'other', owner_uid: 'other' }));
  await engine.tick(); expect(cloud.push).toHaveBeenCalledTimes(50);
  expect(cloud.push.mock.calls.every(([n]) => n.owner_uid === 'owner')).toBe(true);
});
test('watches reference count, unsubscribe on stop, and timer retries offline after 30s', async () => {
  jest.useFakeTimers();
  try {
    const { repo,engine,cloud } = setup(); await repo.putNote(note());
    const first = engine.watch('event-1'), second = engine.watch('event-1');
    expect(cloud.subscribe).toHaveBeenCalledTimes(1); first(); expect(cloud.subscribe.mock.results[0].value).not.toHaveBeenCalled();
    second(); expect(cloud.subscribe.mock.results[0].value).toHaveBeenCalledTimes(1);
    engine.watch('event-2'); engine.start(); await flush(); await jest.advanceTimersByTimeAsync(30000);
    expect(cloud.push).toHaveBeenCalledTimes(1); engine.stop(); expect(jest.getTimerCount()).toBe(0);
    expect(cloud.subscribe.mock.results[1].value).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
test('own tombstone late acknowledgement cannot resurrect it; stale conflict evidence is ignored', async () => {
  const { repo,engine,write,api } = setup(); await repo.putNote(note()); await engine.tick();
  await api.deleteNote(note().id); write.resolve(); await flush();
  expect(await repo.note(note().id)).toMatchObject({ text: '', deleted: 1, revision: 2, synced_revision: 1, sync_state: 'pending' });
  await engine.pull('event-1',[{ note: remote({ revision: 5, deleted: true, text: '' }), pending: false }]);
  await engine.pull('event-1',[{ note: remote({ revision: 4 }), pending: false }]);
  await api.useCloud(note().id); expect(await repo.note(note().id)).toMatchObject({ deleted: 1, text: '', revision: 5, synced_revision: 5 });
});
test('account guard prevents pushes and late callbacks after account switch', async () => {
  const repo = new MemoryRepositories(), write = deferred(); let sameAccount = true;
  const cloud: NoteRemote = { push: jest.fn(() => write.promise), fetchFromServer: jest.fn(), subscribe: jest.fn(() => jest.fn()) };
  const engine = new NoteSyncEngine({ repo, remote: cloud, owner: 'owner', deviceId: 'my-device', canSync: () => sameAccount });
  await repo.putNote(note()); await engine.tick(); sameAccount = false; write.resolve(); await flush();
  expect((await repo.note(note().id))?.synced_revision).toBe(0);
  await engine.tick(); expect(cloud.push).toHaveBeenCalledTimes(1);
});
