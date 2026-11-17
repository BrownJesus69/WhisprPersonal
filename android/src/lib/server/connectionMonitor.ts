import { AppState } from 'react-native';
import { addNetworkStateListener } from 'expo-network';
import { ServerError } from './client';
import { authedClient } from './authedClient';
import { useConnectionStore, type ConnectionStatus } from '@/state/connectionStore';

/** Statuses owned by the Connect flow while it runs; the monitor never overwrites them. */
const CONNECT_FLOW: ConnectionStatus[] = ['testing', 'reachable', 'verifying'];
const AUTH_CODES = new Set(['renew_required', 'auth_token_expired', 'account_not_allowed', 'invalid_token', 'unauthorized']);
export const PROBE_INTERVAL_MS = 60_000;

/** Maps one authenticated probe outcome to the status the UI shows. */
export function statusFromProbe(error: unknown): ConnectionStatus {
  if (!error) return 'connected';
  if (error instanceof ServerError) {
    if (error.status === 0 && ['network_unreachable', 'timeout'].includes(error.code)) return 'disconnected';
    if (AUTH_CODES.has(error.code) || error.status === 401 || error.status === 403) return 'renew_required';
  }
  // Server errors or local failures: reachable but not usable right now.
  return 'error';
}

interface Deps {
  probe: () => Promise<unknown>;
  set: (status: ConnectionStatus) => void;
  current: () => ConnectionStatus;
}

/**
 * Keeps the computer status truthful. Before this, the status started as "not connected" on every
 * launch and only Connect or a successful upload could change it. It probes the authenticated
 * check endpoint on start, when the app returns to the foreground, when the network comes back,
 * and every minute while in the foreground.
 */
export function createConnectionMonitor(d: Deps) {
  let running = false, inFlight = false;
  const probe = async () => {
    if (!running || inFlight) return;
    inFlight = true;
    let error: unknown;
    try { await d.probe(); } catch (e) { error = e; }
    finally { inFlight = false; }
    if (running && !CONNECT_FLOW.includes(d.current())) d.set(statusFromProbe(error));
  };
  return { probe, start() { running = true; void probe(); }, stop() { running = false; } };
}

export function startConnectionMonitor(owner: string): () => void {
  const monitor = createConnectionMonitor({
    probe: async () => {
      const client = authedClient(owner);
      if (!client) throw new ServerError(0, 'network_unreachable', 'No computer address');
      await client.get('/api/v1/auth/check');
    },
    set: status => useConnectionStore.getState().set({ status }),
    current: () => useConnectionStore.getState().status
  });
  monitor.start();
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => { void monitor.probe(); }, PROBE_INTERVAL_MS);
  const app = AppState.addEventListener('change', state => {
    if (state === 'active') {
      void monitor.probe();
      if (!timer) timer = setInterval(() => { void monitor.probe(); }, PROBE_INTERVAL_MS);
    } else if (timer) { clearInterval(timer); timer = undefined; }
  });
  const network = addNetworkStateListener(state => { if (state.isConnected) void monitor.probe(); });
  return () => { monitor.stop(); if (timer) clearInterval(timer); app.remove(); network.remove(); };
}
