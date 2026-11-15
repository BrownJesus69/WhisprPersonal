import { StreamClient, type StreamDependencies } from '../lib/live/streamClient';
import { FakeSocket } from './fakeSocket';
import { finalEvent, hello, liveId } from './liveFixtures';

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function setup(patch: Partial<StreamDependencies> = {}) {
  let cursor = 0;
  const sockets: FakeSocket[] = [];
  const factory = jest.fn(() => { const s = new FakeSocket(); sockets.push(s); return s; });
  const status = jest.fn(), apply = jest.fn(), persist = jest.fn(async e => { cursor = e.seq; });
  const reset = jest.fn(async () => { cursor = 0; });
  const refresh = jest.fn(async () => {}), log = jest.fn();
  const client = new StreamClient({ serverUrl: 'http://127.0.0.1:8770', socket: factory,
    getServerKey: async () => 'test-server-key', getBearer: async () => 'test-bearer', onAuthExpired: refresh,
    session: async () => ({ server_created: 1, last_event_seq: cursor }), persist, resetLastEventSeq: reset,
    apply, status, log, random: () => 0.5, ...patch });
  return { client, sockets, factory, status, apply, persist, reset, refresh, log, cursor: () => cursor };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test.each([['http://127.0.0.1:8770', 'ws://127.0.0.1:8770'], ['https://laptop.example', 'wss://laptop.example']])('URL/header factory %s', async (serverUrl, ws) => {
  const t = setup({ serverUrl, session: async () => ({ server_created: 1, last_event_seq: 9 }) });
  await t.client.start(liveId);
  expect(t.factory).toHaveBeenCalledWith(`${ws}/api/v1/sessions/${liveId}/stream?after_seq=9`, { 'X-WhisprPersonal-Server-Key': 'test-server-key', Authorization: 'Bearer test-bearer' });
  const url = (t.factory.mock.calls as unknown as [string, object][])[0][0];
  expect(url).not.toMatch(/test-server-key|test-bearer/); t.client.stop();
});
test('waits for server_created; unconfigured key fails closed', async () => {
  const t = setup({ session: async () => ({ server_created: 0 }) }); await t.client.start(liveId);
  expect(t.factory).not.toHaveBeenCalled(); expect(t.status).toHaveBeenLastCalledWith('waiting_for_server', 0);
  const k = setup({ getServerKey: async () => null }); await k.client.start(liveId);
  expect(k.factory).not.toHaveBeenCalled(); expect(k.status).toHaveBeenLastCalledWith('auth_required', 0); t.client.stop(); k.client.stop();
});
test('hello/replay persist in order before applying; duplicate seq ignored across reconnect', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].open(); t.sockets[0].message(hello(2));
  for (const e of [finalEvent(1), finalEvent(2, { raw_text: 'revised' }, true), finalEvent(2)]) t.sockets[0].message(e);
  await flush(); expect(t.persist.mock.calls.map(([e]) => e.seq)).toEqual([1,2]); expect(t.cursor()).toBe(2);
  t.sockets[0].close(4008); await flush(); await jest.advanceTimersByTimeAsync(0);
  expect(t.factory).toHaveBeenLastCalledWith(expect.stringContaining('after_seq=2'), expect.anything());
  t.sockets[1].open(); t.sockets[1].message(hello(2)); t.sockets[1].message(finalEvent(2)); await flush();
  expect(t.apply).toHaveBeenCalledTimes(2); t.client.stop();
});
test('lower hello cursor resets and reconnects from zero', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].message(finalEvent(8)); await flush();
  t.sockets[0].message(hello(2)); await flush(); expect(t.reset).toHaveBeenCalledWith(liveId);
  await jest.advanceTimersByTimeAsync(0); expect(t.factory).toHaveBeenLastCalledWith(expect.stringContaining('after_seq=0'), expect.anything()); t.client.stop();
});
test('partial is ephemeral and coalesces to five updates/sec; final clears queued partial', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].open();
  const partial = { type: 'transcript_partial', session_id: liveId, chunk_id: 'c', sequence: 0, data: { start_ms: 0, end_ms: 10, text: 'a' } };
  for (let i = 0; i < 10; i++) t.sockets[0].message({ ...partial, data: { ...partial.data, text: String(i) } });
  await flush(); expect(t.apply).toHaveBeenCalledTimes(1); expect(t.persist).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(200); expect(t.apply).toHaveBeenCalledTimes(2);
  t.sockets[0].message(partial); t.sockets[0].message(finalEvent()); await flush();
  await jest.advanceTimersByTimeAsync(200); expect(t.apply).toHaveBeenCalledTimes(3); t.client.stop();
});
test('ping sends pong; watchdog reconnects after 50s without inbound', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].open(); t.sockets[0].message(hello()); t.sockets[0].message({ type: 'ping' }); await flush();
  expect(t.sockets[0].sent).toContain('{"type":"pong"}');
  await jest.advanceTimersByTimeAsync(49_999); expect(t.sockets).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(501); expect(t.sockets).toHaveLength(2); t.client.stop();
});
test.each([[4008,0,'reconnecting'], [4404,30_000,'waiting_for_server'], [4429,10_000,'reconnecting'], [1006,500,'reconnecting'], [4503,500,'reconnecting'], [1008,500,'reconnecting'], [4400,500,'reconnecting']])('close %i maps to retry %i', async (code, ms, status) => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].close(code); await flush();
  expect(t.status).toHaveBeenLastCalledWith(status, code === 4008 || code === 4404 ? 0 : 1);
  if (ms) { await jest.advanceTimersByTimeAsync(ms - 1); expect(t.sockets).toHaveLength(1); await jest.advanceTimersByTimeAsync(1); }
  else await jest.advanceTimersByTimeAsync(0);
  expect(t.sockets).toHaveLength(2); t.client.stop();
});
test('4401 refreshes once; second failure stops until credentials restart', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].close(4401); await flush();
  expect(t.refresh).toHaveBeenCalledTimes(1); await jest.advanceTimersByTimeAsync(500);
  t.sockets[1].close(4401); await flush(); expect(t.status).toHaveBeenLastCalledWith('auth_required',1);
  t.client.reconnect(); await jest.advanceTimersByTimeAsync(60_000); expect(t.sockets).toHaveLength(2);
  t.client.stop(); await t.client.start(liveId); expect(t.sockets).toHaveLength(3); t.client.stop();
});
test('refresh failure and 4403 stop all retries', async () => {
  const t = setup({ onAuthExpired: async () => { throw new Error('Offline'); } }); await t.client.start(liveId); t.sockets[0].close(4401); await flush();
  expect(t.status).toHaveBeenLastCalledWith('auth_required',0); expect(jest.getTimerCount()).toBe(0);
  const k = setup(); await k.client.start(liveId); k.sockets[0].close(4403); await flush(); expect(k.status).toHaveBeenLastCalledWith('not_allowed',0); expect(jest.getTimerCount()).toBe(0); t.client.stop(); k.client.stop();
});
test('full jitter envelope caps at 30s; 30s healthy resets attempt counter', async () => {
  const t = setup({ random: () => 1 }); await t.client.start(liveId);
  for (let i = 0; i < 8; i++) {
    t.sockets[i].close(1006); await flush(); const delay = Math.min(30_000, 1000 * 2 ** i);
    await jest.advanceTimersByTimeAsync(delay - 1); expect(t.sockets).toHaveLength(i + 1);
    await jest.advanceTimersByTimeAsync(1); expect(t.sockets).toHaveLength(i + 2);
  }
  const socket = t.sockets.at(-1)!; socket.open(); socket.message(hello()); await flush();
  await jest.advanceTimersByTimeAsync(30_000); expect(t.status).toHaveBeenLastCalledWith('live',0);
  socket.close(1006); await flush(); await jest.advanceTimersByTimeAsync(1000); expect(t.sockets).toHaveLength(10); t.client.stop();
});
test('setLanguage only sends JSON on open; stop removes listeners/timers idempotently', async () => {
  const t = setup(); await t.client.start(liveId); expect(t.client.setLanguage('kn')).toBe(false);
  t.sockets[0].open(); expect(t.client.setLanguage('ta')).toBe(true); expect(t.sockets[0].sent).toEqual(['{"type":"set_language","language":"ta"}']);
  t.client.stop(); t.client.stop(); expect(jest.getTimerCount()).toBe(0);
  expect(Object.values(t.sockets[0].listeners).every(s => s.size === 0)).toBe(true);
});
test('rejects malformed and wrong-session events using only safe codes', async () => {
  const t = setup(); await t.client.start(liveId);
  for (const e of ['{bad', { ...finalEvent(), data: { raw_text: 'sensitive' } }, { ...finalEvent(), session_id: 'other' }]) t.sockets[0].message(e);
  await flush(); expect(t.persist).not.toHaveBeenCalled(); expect(t.apply).not.toHaveBeenCalled();
  expect(t.log.mock.calls.flat()).toEqual(['malformed_stream_event','malformed_stream_event','stream_session_mismatch']); t.client.stop();
});
test('persistence failure reconnects without advancing cursor or exposing text', async () => {
  const t = setup({ persist: async () => { throw new Error('private'); } }); await t.client.start(liveId); t.sockets[0].message(finalEvent()); await flush();
  expect(t.apply).not.toHaveBeenCalled(); expect(t.cursor()).toBe(0); expect(t.log).toHaveBeenCalledWith('stream_persistence_failed'); t.client.stop();
});
test('deletion stops; finalized session catches up to hello high-water mark before stopping', async () => {
  const t = setup(); await t.client.start(liveId); t.sockets[0].message(hello(3));
  t.sockets[0].message({ type: 'session_finalized', seq: 1, session_id: liveId, ts: 'now', data: { transcript_status: 'complete', missing_sequences: [], failed_sequences: [] } });
  t.sockets[0].message(finalEvent(2)); t.sockets[0].message(finalEvent(3, {}, true)); await flush();
  expect(t.apply).toHaveBeenCalledTimes(3); expect(t.status).toHaveBeenLastCalledWith('stopped',0); expect(jest.getTimerCount()).toBe(0);
  const d = setup(); await d.client.start(liveId); d.sockets[0].message({ type: 'session_deleted', session_id: liveId, seq: 1, ts: 'now', data: {} }); d.sockets[0].close(1000); await flush(); expect(d.status).toHaveBeenLastCalledWith('stopped',0); expect(jest.getTimerCount()).toBe(0);
});
test('stopping during async credentials cannot create a late socket', async () => {
  let release!: (value: string) => void;
  const t = setup({ getBearer: () => new Promise(resolve => { release = resolve; }) });
  const started = t.client.start(liveId); await flush(); t.client.stop(); release('test'); await started;
  expect(t.factory).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
});
