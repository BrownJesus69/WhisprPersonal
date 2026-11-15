import { getIdToken, signOut } from '@react-native-firebase/auth';
import { getNetworkStateAsync } from 'expo-network';
import { credentials, type OfflinePass } from '@/lib/server/credentials';
import { createTokenManager, signOutAccount } from '@/lib/server/tokenManager';
import { useConnectionStore } from '@/state/connectionStore';
import { mockFetch, response } from './helpers';
const url = 'http://192.168.1.20:8000';
const pass = (seconds: number): OfflinePass => ({
  grant: 'wpg1.test-only',
  expiresAt: Date.now() / 1000 + seconds,
  grantId: 'g',
  serverUrl: url,
  uid: 'test-user'
});
beforeEach(async () => {
  await credentials.clearPass();
  await credentials.setServerKey('test-key');
  jest.mocked(getNetworkStateAsync).mockResolvedValue({ isConnected: true, isInternetReachable: true });
});

test('valid pass used', async () => {
  await credentials.setPass(pass(7201));
  await expect(createTokenManager(url).getBearer()).resolves.toBe('wpg1.test-only');
  expect(getIdToken).not.toHaveBeenCalled();
});

test('pass below five minutes falls back to Firebase', async () => {
  await credentials.setPass(pass(299));
  await expect(createTokenManager(url).getBearer()).resolves.toBe('test-firebase-token');
});

test('pass is bound to account and server', async () => {
  await credentials.setPass({ ...pass(7201), uid: 'other-user' });
  await expect(createTokenManager(url).getBearer()).resolves.toBe('test-firebase-token');
  await credentials.setPass(pass(7201));
  await expect(createTokenManager('http://localhost').getBearer()).resolves.toBe('test-firebase-token');
});

test('ensurePass renews with fresh Firebase token, never the pass', async () => {
  await credentials.setPass(pass(7199));
  mockFetch().mockResolvedValue(response({
    grant: 'wpg1.renewed-test',
    expires_at: Date.now() / 1000 + 43200,
    ttl_s: 43200,
    grant_id: 'renewed'
  }));
  await createTokenManager(url).ensurePass();
  expect(getIdToken).toHaveBeenCalledWith(expect.anything(), true);
  expect(mockFetch().mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-firebase-token' });
  expect(await credentials.getPass()).toMatchObject({ grantId: 'renewed' });
});

test('long lived pass does not renew', async () => {
  await credentials.setPass(pass(7201));
  await createTokenManager(url).ensurePass();
  expect(mockFetch()).not.toHaveBeenCalled();
});

test('offline expired pass needs renewal', async () => {
  await credentials.setPass(pass(-1));
  jest.mocked(getNetworkStateAsync).mockResolvedValue({ isConnected: true, isInternetReachable: false });
  await expect(createTokenManager(url).onAuthExpired()).rejects.toThrow('Reconnect to the internet');
  expect(useConnectionStore.getState().status).toBe('renew_required');
});

test('sign out clears pass even when revoke fails and keeps key', async () => {
  await credentials.setPass(pass(7201));
  await signOutAccount();
  expect(await credentials.getPass()).toBeNull();
  expect(await credentials.getServerKey()).toBe('test-key');
  expect(signOut).toHaveBeenCalled();
});
