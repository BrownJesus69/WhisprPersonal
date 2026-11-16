import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import Setup from '@/app/setup';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { credentials } from '@/lib/server/credentials';
import { health } from './fixtures';
import { mockFetch, response } from './helpers';
import { t } from '@/i18n';

beforeEach(() => { useSettingsStore.setState(defaults); useConnectionStore.setState({ status: 'disconnected', scannedUrl: null }); });
async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
  const view = await render(<QueryClientProvider client={client}><Setup /></QueryClientProvider>);
  return { view, client };
}
test('language choice saves; Not now finishes without requesting a microphone', async () => {
  const { view, client } = await setup();
  await fireEvent.press(view.getByLabelText(t('ta')));
  expect(useSettingsStore.getState().defaultLanguageMode).toBe('ta');
  await fireEvent.press(view.getByLabelText(t('notNow')));
  expect(useSettingsStore.getState().onboarding).toBe('done');
  expect(router.replace).toHaveBeenCalledWith('/');
  expect(mockFetch()).not.toHaveBeenCalled(); await view.unmount(); client.clear();
});
test('connect checks run in order and loading recognition offers Check again', async () => {
  await credentials.clearPass();
  mockFetch().mockResolvedValueOnce(response({ ...health, model: { ...health.model, status: 'loading' }, auth: { ...health.auth, grants: { enabled: false, ttl_hours: 12 } } }))
    .mockResolvedValueOnce(response({ uid: 'test-user' }));
  const { view, client } = await setup();
  await fireEvent.press(view.getByLabelText(t('next')));
  for (const label of ['reachable', 'accepted', 'recognitionReady'] as const) expect(view.getByText(t(label))).toBeTruthy();
  expect(view.getAllByText(t('waiting'))).toHaveLength(3);
  await fireEvent.changeText(view.getByLabelText(t('computerAddress')), 'http://192.168.1.20:8000');
  await fireEvent.changeText(view.getByLabelText(t('serverKey')), 'test-only-key');
  await fireEvent.press(view.getByLabelText(t('connectAction')));
  await view.findByLabelText(t('checkAgain'));
  expect(view.getAllByText(`✓ ${t('passed')}`)).toHaveLength(2);
  expect(view.getByText(`× ${t('stillLoading')}`)).toBeTruthy();
  expect(useSettingsStore.getState().onboarding).toBe('pending');
  mockFetch().mockResolvedValueOnce(response({ ...health, model: { ...health.model, status: 'ready' }, auth: { ...health.auth, grants: { enabled: false, ttl_hours: 12 } } }))
    .mockResolvedValueOnce(response({ uid: 'test-user' }));
  await fireEvent.press(view.getByLabelText(t('checkAgain')));
  await view.findByText(t('tryIt'));
  await fireEvent.press(view.getByLabelText(t('start')));
  expect(useSettingsStore.getState().onboarding).toBe('done'); expect(router.replace).toHaveBeenCalledWith('/');
  await view.unmount(); client.clear();
});
test('failed reachability leaves auth and recognition waiting and skip still works', async () => {
  mockFetch().mockRejectedValue(new Error('offline'));
  const { view, client } = await setup();
  await fireEvent.press(view.getByLabelText(t('next')));
  await fireEvent.changeText(view.getByLabelText(t('computerAddress')), 'http://192.168.1.20:8000');
  await fireEvent.press(view.getByLabelText(t('connectAction')));
  await waitFor(() => expect(useConnectionStore.getState().status).toBe('error'));
  expect(view.getAllByText(t('waiting'))).toHaveLength(2);
  expect(view.getByText(/^× /)).toBeTruthy();
  await fireEvent.press(view.getByLabelText(t('notNow'))); expect(useSettingsStore.getState().onboarding).toBe('done');
  await view.unmount(); client.clear();
});
test('a rejected key passes reachability, fails auth, and does not claim recognition passed', async () => {
  mockFetch().mockResolvedValueOnce(response(health)).mockResolvedValueOnce(response({ error: { code: 'invalid_server_key', message: 'Rejected', request_id: 'test' } }, 401));
  const { view, client } = await setup();
  await fireEvent.press(view.getByLabelText(t('next')));
  await fireEvent.changeText(view.getByLabelText(t('computerAddress')), 'http://192.168.1.20:8000');
  await fireEvent.changeText(view.getByLabelText(t('serverKey')), 'test-only-key');
  await fireEvent.press(view.getByLabelText(t('connectAction')));
  await waitFor(() => expect(useConnectionStore.getState().status).toBe('error'));
  expect(view.getAllByText(`✓ ${t('passed')}`)).toHaveLength(1);
  expect(view.getAllByText(t('waiting'))).toHaveLength(1);
  expect(view.getByText(/^× /)).toBeTruthy();
  expect(useSettingsStore.getState().onboarding).toBe('pending');
  await view.unmount(); client.clear();
});
