import { createConnectionMonitor, statusFromProbe } from '@/lib/server/connectionMonitor';
import { ServerError } from '@/lib/server/client';
import type { ConnectionStatus } from '@/state/connectionStore';

test('probe outcomes map to truthful statuses', () => {
  expect(statusFromProbe(undefined)).toBe('connected');
  expect(statusFromProbe(new ServerError(0, 'network_unreachable', 'x'))).toBe('disconnected');
  expect(statusFromProbe(new ServerError(0, 'timeout', 'x'))).toBe('disconnected');
  expect(statusFromProbe(new ServerError(401, 'auth_token_expired', 'x'))).toBe('renew_required');
  expect(statusFromProbe(new ServerError(403, 'account_not_allowed', 'x'))).toBe('renew_required');
  expect(statusFromProbe(new ServerError(500, 'internal_error', 'x'))).toBe('error');
});

function monitor(probe: () => Promise<unknown>, initial: ConnectionStatus = 'disconnected') {
  let status = initial;
  const m = createConnectionMonitor({ probe, set: s => { status = s; }, current: () => status });
  return { m, status: () => status, setStatus: (s: ConnectionStatus) => { status = s; } };
}

test('a launch with a reachable computer shows connected without tapping Connect', async () => {
  const t = monitor(async () => ({ uid: 'owner' }));
  t.m.start(); await t.m.probe(); await new Promise(r => setTimeout(r, 0));
  expect(t.status()).toBe('connected');
});

test('never overrides the Connect flow while it runs', async () => {
  let release!: () => void;
  const t = monitor(() => new Promise<void>((_, reject) => { release = () => reject(new ServerError(0, 'network_unreachable', 'x')); }));
  t.m.start(); t.setStatus('verifying'); release(); await new Promise(r => setTimeout(r, 0));
  expect(t.status()).toBe('verifying');
});

test('stopped monitors do not write', async () => {
  let release!: () => void;
  const t = monitor(() => new Promise<void>(r => { release = r; }));
  t.m.start(); t.m.stop(); release(); await new Promise(r => setTimeout(r, 0));
  expect(t.status()).toBe('disconnected');
});
