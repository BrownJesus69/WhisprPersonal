import { clearKeyboardConfig } from '@/features/keyboard/syncKeyboard';
import { getNetworkStateAsync } from 'expo-network';
import { auth } from '@/lib/firebase/auth';
import { credentials } from './credentials';
import { ServerClient, ServerError } from './client';
import type { GrantResponse } from './types';
import { useConnectionStore } from '@/state/connectionStore';
import { useSettingsStore } from '@/state/settingsStore';

export function createTokenManager(baseUrl: string) {
  let forceNext = false;
  async function matchingPass() {
    const pass = await credentials.getPass();
    return pass?.serverUrl === baseUrl && pass.uid === auth.current()?.uid ? pass : null;
  }
  async function getBearer() {
    const pass = await matchingPass();
    if (!forceNext && pass && pass.expiresAt - Date.now() / 1000 > 300)
      return pass.grant;
    const force = forceNext;
    forceNext = false;
    try {
      return await auth.idToken(force);
    }
    catch {
      const network = await getNetworkStateAsync();
      if (network.isConnected === false || network.isInternetReachable === false) {
        useConnectionStore.getState().set({ status: 'renew_required' });
        throw new ServerError(0, 'auth_token_expired', 'Reconnect to the internet to renew sign-in');
      }
      throw new ServerError(0, 'auth_unavailable', 'Sign in again to connect to the laptop');
    }
  }
  async function onAuthExpired() {
    forceNext = true;
    const network = await getNetworkStateAsync();
    if (network.isInternetReachable === false || network.isConnected === false) {
      const pass = await matchingPass();
      if (!pass || pass.expiresAt <= Date.now() / 1000) {
        useConnectionStore.getState().set({ status: 'renew_required' });
        throw new ServerError(0, 'auth_token_expired', 'Reconnect to the internet to renew sign-in');
      }
    }
    try {
      await auth.idToken(true);
    }
    catch {
      throw new ServerError(0, 'auth_unavailable', 'Reconnect to the internet to renew sign-in');
    }
  }
  const client = new ServerClient({
    baseUrl,
    getServerKey: credentials.getServerKey,
    getBearer,
    onAuthExpired
  });
  async function ensurePass() {
    const user = auth.current();
    if (!user)
      return;
    const pass = await matchingPass();
    if (pass && pass.expiresAt - Date.now() / 1000 >= 7200) {
      useConnectionStore.getState().set({ passExpiry: pass.expiresAt });
      return;
    }
    const network = await getNetworkStateAsync();
    if (network.isConnected === false || network.isInternetReachable === false)
      return;
    // Dedicated grant client cannot select an offline pass, including on retry.
    const grantClient = new ServerClient({
      baseUrl,
      getServerKey: credentials.getServerKey,
      getBearer: () => auth.idToken(true),
      onAuthExpired: async () => {
        await auth.idToken(true);
      }
    });
    const result = await grantClient.post<GrantResponse>('/api/v1/auth/grant');
    if (auth.current()?.uid !== user.uid)
      return;
    await credentials.setPass({
      grant: result.grant,
      expiresAt: result.expires_at,
      grantId: result.grant_id,
      serverUrl: baseUrl,
      uid: user.uid
    });
    useConnectionStore.getState().set({ passExpiry: result.expires_at });
  }
  return {
    client,
    getBearer,
    onAuthExpired,
    ensurePass
  };
}

export async function signOutAccount() {
  const pass = await credentials.getPass();
  try {
    if (pass) {
      const manager = createTokenManager(pass.serverUrl);
      await manager.client.post('/api/v1/auth/grant/revoke', { grant_id: pass.grantId }, { auth: true, timeoutMs: 2500 });
    }
  }
  catch {
    // Revocation is best effort; sign-out must still erase the local pass.
  }
  finally {
    await credentials.clearPass();
    useConnectionStore.getState().set({ check: null, passExpiry: null, status: 'disconnected' });
    try { await clearKeyboardConfig(); }
    finally { await auth.signOut(); }
  }
}

export async function renewOnForeground() {
  const url = useSettingsStore.getState().serverUrl;
  if (!url)
    return;
  try {
    await createTokenManager(url).ensurePass();
  }
  catch {
    // Foreground renewal must not block app startup; Connect provides a retry.
  }
}
