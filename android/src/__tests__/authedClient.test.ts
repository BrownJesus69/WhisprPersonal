import { authedClient } from '../lib/server/authedClient';
import { ServerClient } from '../lib/server/client';
import { createTokenManager } from '../lib/server/tokenManager';
import { useAuthStore } from '../state/authStore';
import { useSettingsStore } from '../state/settingsStore';

jest.mock('../lib/server/client', () => ({ ...jest.requireActual('../lib/server/client'), ServerClient: jest.fn() }));
jest.mock('../lib/server/tokenManager', () => ({ createTokenManager: jest.fn() }));
beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'http://192.168.1.2:8000' });
  useAuthStore.getState().setUser({ uid: 'test-user', email: null, provider: 'password' });
});
function setup(getBearer = jest.fn(async () => 'mock bearer')) {
  const onAuthExpired = jest.fn(async () => {});
  jest.mocked(createTokenManager).mockReturnValue({ getBearer, onAuthExpired } as never);
  authedClient('test-user');
  const options = jest.mocked(ServerClient).mock.calls[0][0];
  return { options, getBearer, onAuthExpired };
}
test('no server URL disables the client without constructing authentication', () => {
  useSettingsStore.setState({ serverUrl: '' }); expect(authedClient('test-user')).toBeNull();
  expect(createTokenManager).not.toHaveBeenCalled(); expect(ServerClient).not.toHaveBeenCalled();
});
test('uses the server URL token manager, credential getter and renewal handler', async () => {
  const { options, onAuthExpired } = setup();
  expect(createTokenManager).toHaveBeenCalledWith('http://192.168.1.2:8000');
  expect(options.getServerKey).toEqual(expect.any(Function)); expect(options.onAuthExpired).toBe(onAuthExpired);
  expect(await options.getBearer()).toBe('mock bearer');
});
test('account guard rejects before retrieving a bearer', async () => {
  const { options, getBearer } = setup(); useAuthStore.getState().setUser(null);
  await expect(options.getBearer()).rejects.toMatchObject({ code: 'renew_required' }); expect(getBearer).not.toHaveBeenCalled();
});
test('account guard rejects a signout that happens while retrieving a bearer', async () => {
  const { options } = setup(jest.fn(async () => { useAuthStore.getState().setUser(null); return 'mock bearer'; }));
  await expect(options.getBearer()).rejects.toMatchObject({ code: 'renew_required' });
});
