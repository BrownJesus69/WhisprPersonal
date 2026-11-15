import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { SectionHeader } from '@/components/SectionHeader';
import { HealthPanel } from '@/components/HealthPanel';
import { KeyValueRow } from '@/components/KeyValueRow';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useAuthStore } from '@/state/authStore';
import { parseServerUrl } from '@/lib/server/serverUrl';
import { credentials } from '@/lib/server/credentials';
import { createTokenManager } from '@/lib/server/tokenManager';
import { ServerError } from '@/lib/server/client';
import { serverMessage } from '@/lib/server/messages';
import { useHealth } from '@/hooks/useHealth';
import { useAuthCheck } from '@/hooks/useAuthCheck';

export default function Connect() {
  const settings = useSettingsStore();
  const connection = useConnectionStore();
  const uid = useAuthStore(s => s.user?.uid);
  const [address, setAddress] = useState(settings.serverUrl);
  const [key, setKey] = useState('');
  const [tested, setTested] = useState('');
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const health = useHealth();
  const check = useAuthCheck();
  useEffect(() => {
    void credentials.getServerKey().then(value => setKey(value ?? '')).catch(() => setMessage('Could not read secure storage'));
  }, []);
  useEffect(() => useConnectionStore.subscribe((state) => {
    if (state.scannedUrl) {
      setAddress(state.scannedUrl);
      setTested('');
      setVerified(false);
      state.set({ scannedUrl: null });
    }
  }), []);
  useEffect(() => {
    if (!retryAt)
      return;
    const timer = setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);
  function showError(error: unknown) {
    if (error instanceof ServerError && error.retryAfterS)
      setRetryAt(Date.now() + error.retryAfterS * 1000);
    setMessage(error instanceof ServerError && error.status > 0
      ? serverMessage(error.code, error.status, error.retryAfterS)
      : error instanceof Error ? error.message : 'Connection failed');
  }
  let kind = '';
  try {
    kind = parseServerUrl(address).kind.toUpperCase();
  }
  catch {
    // Validate only when the user submits an address.
  }
  function changeAddress(value: string) {
    setAddress(value);
    setTested('');
    setVerified(false);
    setMessage('');
  }
  async function test() {
    if (retryAt > Date.now())
      return;
    setMessage('');
    setVerified(false);
    setTested('');
    connection.set({ status: 'testing', check: null, passExpiry: null });
    try {
      const parsed = parseServerUrl(address);
      const result = await health.mutateAsync(parsed.url);
      connection.set({ health: result, status: 'reachable' });
      setTested(parsed.url);
    }
    catch (e) {
      connection.set({ status: 'error' });
      showError(e);
    }
  }
  async function verify() {
    if (retryAt > Date.now())
      return;
    setBusy(true);
    setMessage('');
    setVerified(false);
    connection.set({ status: 'verifying' });
    try {
      await credentials.setServerKey(key.trim());
      const result = await check.mutateAsync(tested);
      connection.set({ check: result });
      if (health.data?.auth.grants.enabled)
        await createTokenManager(tested).ensurePass();
      setVerified(true);
      connection.set({ status: 'verified' });
    }
    catch (e) {
      connection.set({ status: e instanceof ServerError && e.code === 'auth_token_expired' ? 'renew_required' : 'error' });
      showError(e);
    }
    finally {
      setBusy(false);
    }
  }
  return <Screen title="Your laptop, connected">
    <SectionHeader title="1 · Server address" />
    <TextField
      label="Laptop URL"
      editable={!busy && !health.isPending}
      autoCapitalize="none"
      autoCorrect={false}
      value={address}
      onChangeText={changeAddress}
      placeholder="LAN or Tailscale address"
    />
    {kind && <Banner message={kind} />}
    <Button
      secondary
      label="Scan QR"
      disabled={busy || health.isPending}
      onPress={() => router.push('/scan')}
    />
    <Button
      label={connection.status === 'connected' ? 'Reconnect' : 'Test connection'}
      disabled={busy || retryAt > 0}
      loading={health.isPending}
      onPress={() => void test()}
    />
    {message && <Banner error message={message} />}
    <>
      {tested && health.data && <HealthPanel health={health.data} />}
    </>
    <SectionHeader title="2 · Server key" />
    <TextField
      label="Server key"
      editable={!busy && !health.isPending}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      value={key}
      onChangeText={value => {
        setKey(value);
        setVerified(false);
      }}
    />
    <SectionHeader title="3 · Verify sign-in" />
    <Button
      label="Verify sign-in"
      disabled={!tested || !key.trim() || health.isPending || retryAt > 0}
      loading={busy}
      onPress={() => void verify()}
    />
    {(connection.check || message.includes('not allowed')) && <>
      <KeyValueRow label="UID (hold to copy)" value={connection.check?.uid ?? uid} selectable />
      <Banner message="Add this UID to AUTH_ALLOWED_UIDS on the laptop." />
    </>}
    {connection.check && <KeyValueRow label="Auth method" value={connection.check.auth_method} />}
    {connection.passExpiry && <Banner message={`Offline pass valid until ${new Date(connection.passExpiry * 1000).toLocaleString()}`} />}
    <Button label="Save connection" disabled={!verified} onPress={() => {
      settings.set({ serverUrl: tested });
      connection.set({ status: 'connected' });
      router.back();
    }} />
    {verified && !health.data?.auth.grants.enabled && <Banner message="Connected. Offline passes are disabled on this laptop." />}
  </Screen>;
}
