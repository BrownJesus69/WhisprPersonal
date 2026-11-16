import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import keyboard from '../../modules/whispr-keyboard';
import KeyboardSetup from '@/app/keyboard-setup';
import { syncKeyboard, clearKeyboardConfig, startKeyboardSync } from '@/features/keyboard/syncKeyboard';
import { credentials } from '@/lib/server/credentials';
import { defaults, normalizeSettings, useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';
import { t } from '@/i18n';

beforeEach(async () => {
  await clearKeyboardConfig();
  jest.clearAllMocks();
  useSettingsStore.setState(defaults);
  useAuthStore.setState({ user: { uid: 'owner', email: null, provider: 'password' }, status: 'signed_in' });
});

test('keyboard preferences normalize and persist dismissal', () => {
  expect(normalizeSettings({})).toMatchObject({ reviewBeforeInsert: false, haptics: true, keyboardPromptDismissed: false });
  expect(normalizeSettings({ reviewBeforeInsert: true, haptics: false, keyboardPromptDismissed: true })).toMatchObject({ reviewBeforeInsert: true, haptics: false, keyboardPromptDismissed: true });
  expect(normalizeSettings({ reviewBeforeInsert: 'yes', haptics: null, keyboardPromptDismissed: 1 } as never)).toMatchObject({ reviewBeforeInsert: false, haptics: true, keyboardPromptDismissed: false });
});

test('sync uses secure credentials, owner event and preferences without logging', async () => {
  const log = jest.spyOn(console, 'log'), warn = jest.spyOn(console, 'warn'), error = jest.spyOn(console, 'error');
  const key = 'test-only-server-value';
  await credentials.setServerKey(key);
  useSettingsStore.setState({ serverUrl: 'http://192.168.1.2:8000', defaultLanguageMode: 'kn', reviewBeforeInsert: true, haptics: false, speakEventIds: { owner: 'personal-event' } });
  await syncKeyboard();
  expect(keyboard.setConfig).toHaveBeenCalledWith({ serverUrl: 'http://192.168.1.2:8000', serverKey: key, languageMode: 'kn', reviewBeforeInsert: true, haptics: false, speakEventId: 'personal-event' });
  expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(key);
  useAuthStore.setState({ user: null, status: 'signed_out' });
  await syncKeyboard();
  expect(keyboard.clearConfig).toHaveBeenCalledTimes(1);
  log.mockRestore(); warn.mockRestore(); error.mockRestore();
});

test('runtime sync follows settings and sign-out and unsubscribes', async () => {
  const fail = jest.fn(); const stop = startKeyboardSync(fail);
  await syncKeyboard();
  useSettingsStore.getState().set({ serverUrl: 'http://192.168.1.2:8000', haptics: false });
  await syncKeyboard();
  expect(keyboard.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ haptics: false }));
  useAuthStore.getState().setUser(null);
  await syncKeyboard();
  expect(keyboard.clearConfig).toHaveBeenCalled();
  stop(); expect(fail).not.toHaveBeenCalled();
});

test('sign-out invalidates a pending secure-storage read', async () => {
  let resolve!: (value: string | null) => void;
  const getter = jest.spyOn(credentials, 'getServerKey').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  useSettingsStore.setState({ serverUrl: 'http://192.168.1.2:8000' });
  const work = syncKeyboard();
  await Promise.resolve(); await Promise.resolve();
  useAuthStore.setState({ user: null, status: 'signed_out' });
  const clearing = clearKeyboardConfig(); resolve('test-only-server-value');
  await work; await clearing;
  expect(keyboard.setConfig).not.toHaveBeenCalled(); expect(keyboard.clearConfig).toHaveBeenCalled();
  getter.mockRestore();
});

test('setup reads system state and rechecks when active', async () => {
  let changed!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, fn) => { changed = fn; return { remove }; });
  jest.mocked(keyboard.isEnabled).mockResolvedValue(false);
  jest.mocked(keyboard.isSelected).mockResolvedValue(false);
  const view = await render(<KeyboardSetup />);
  expect(view.queryByText(`✓ ${t('keyboardEnabled')}`)).toBeNull();
  await fireEvent.press(view.getByLabelText(t('keyboardOpenSettings')));
  expect(keyboard.openInputMethodSettings).toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText(t('keyboardChoose'))); expect(keyboard.showPicker).toHaveBeenCalled();
  jest.mocked(keyboard.isEnabled).mockResolvedValue(true); jest.mocked(keyboard.isSelected).mockResolvedValue(true);
  await act(async () => changed('active'));
  expect(view.getByText(`✓ ${t('keyboardEnabled')}`)).toBeTruthy(); expect(view.getByText(`✓ ${t('keyboardSelected')}`)).toBeTruthy();
  expect(keyboard.isEnabled).toHaveBeenCalledTimes(2);
  await view.unmount(); expect(remove).toHaveBeenCalled(); listener.mockRestore();
});
