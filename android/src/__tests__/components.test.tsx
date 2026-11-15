import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBadge } from '@/components/StatusBadge';
import Connect from '@/app/connect';
import SignIn from '@/app/(auth)/sign-in';
import { EVENT_STATUSES } from '@/types/models';
import { useSettingsStore, defaults } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { health } from './fixtures';
import { response, mockFetch } from './helpers';
import { credentials } from '@/lib/server/credentials';
test.each(EVENT_STATUSES)('status %s has readable text', async (status) => {
  const view = await render(<StatusBadge status={status} />);
  expect(view.getByText(status[0].toUpperCase() + status.slice(1))).toBeTruthy();
});

test('Google button hidden when feature off', async () => {
  const view = await render(<SignIn />);
  expect(view.queryByText('Continue with Google')).toBeNull();
  expect(view.getByLabelText('Email')).toBeTruthy();
});
async function connect() {
  useSettingsStore.setState({ ...defaults, serverUrl: 'http://192.168.1.20:8000' });
  useConnectionStore.getState().set({
    health: null,
    status: 'disconnected',
    check: null,
    passExpiry: null,
    scannedUrl: null
  });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false, gcTime: Infinity } } })}>
    <Connect />
  </QueryClientProvider>);
}

test('Connect renders health from a mocked public request', async () => {
  mockFetch().mockResolvedValue(response(health));
  const view = await connect();
  await fireEvent.press(view.getByText('Test connection'));
  await waitFor(() => expect(view.getByText('test-version')).toBeTruthy());
  expect(view.getByText('Supported languages')).toBeTruthy();
  expect(view.getByText('test fixture model')).toBeTruthy();
});

test('Connect explains unreachable laptop', async () => {
  mockFetch().mockRejectedValue(new Error('offline'));
  const view = await connect();
  await fireEvent.press(view.getByText('Test connection'));
  await waitFor(() => expect(view.getByText("Can't reach the laptop. Same Wi-Fi/Tailscale? Server running?")).toBeTruthy());
});

test('Connect verifies sign-in and obtains a pass with a Firebase token', async () => {
  await credentials.clearPass();
  mockFetch()
    .mockResolvedValueOnce(response(health))
    .mockResolvedValueOnce(response({uid:'test-user',email:'test@example.test',email_verified:false,sign_in_provider:'password',server_version:'test-version',auth_method:'firebase',grant_expires_at:null}))
    .mockResolvedValueOnce(response({grant:'wpg1.component-test',expires_at:Date.now()/1000+43200,ttl_s:43200,grant_id:'component-pass'}));
  const view=await connect();
  await fireEvent.press(view.getByText('Test connection'));
  await view.findByText('test-version');
  await fireEvent.changeText(view.getByLabelText('Server key'),'component-test-key');
  await fireEvent.press(view.getByText('Verify sign-in'));
  await view.findByText(/Offline pass valid until/);
  expect(view.getByText('Save connection')).toBeEnabled();
  expect(view.getByText('test-user')).toBeOnTheScreen();
  expect(mockFetch().mock.calls[2][1]?.headers).toMatchObject({Authorization:'Bearer test-firebase-token'});
});

test('scanned URL replaces the address and requires a new test', async () => {
  const view=await connect();
  await act(async()=>useConnectionStore.getState().set({scannedUrl:'http://100.64.0.1:8000'}));
  expect(view.getByLabelText('Laptop URL')).toHaveDisplayValue('http://100.64.0.1:8000');
  expect(view.getByText('Verify sign-in')).toBeDisabled();
});

test('Connect disables retries for Retry-After', async () => {
  mockFetch().mockResolvedValue(response({error:{code:'rate_limited',message:'wait',request_id:'test'}},429,'30'));
  const view=await connect();
  await fireEvent.press(view.getByText('Test connection'));
  await view.findByText('Too many requests. Try again in 30 seconds');
  expect(view.getByText('Test connection')).toBeDisabled();
  expect(mockFetch()).toHaveBeenCalledTimes(1);
});
