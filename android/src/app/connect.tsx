import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { HealthPanel } from '@/components/HealthPanel';
import { KeyValueRow } from '@/components/KeyValueRow';
import { Collapsible } from '@/components/Collapsible';
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

/**
 * One button does everything: reach the laptop, check the server key and sign-in, get the
 * offline pass, and save. The steps are unchanged; they just no longer need three taps.
 */
export default function Connect() {
  const settings = useSettingsStore();
  const connection = useConnectionStore();
  const uid = useAuthStore(s => s.user?.uid);
  const [address, setAddress] = useState(settings.serverUrl);
  const [key, setKey] = useState('');
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
      setMessage('');
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
  async function connect() {
    if (retryAt > Date.now())
      return;
    setBusy(true);
    setMessage('');
    connection.set({ status: 'testing', check: null, passExpiry: null });
    try {
      const url = parseServerUrl(address).url;
      const result = await health.mutateAsync(url);
      connection.set({ health: result, status: 'verifying' });
      if (!key.trim())
        throw new Error('Enter the server key shown on the laptop.');
      await credentials.setServerKey(key.trim());
      connection.set({ check: await check.mutateAsync(url) });
      if (result.auth.grants.enabled)
        await createTokenManager(url).ensurePass();
      settings.set({ serverUrl: url });
      connection.set({ status: 'connected' });
      router.back();
    }
    catch (e) {
      connection.set({ status: e instanceof ServerError && e.code === 'auth_token_expired' ? 'renew_required' : 'error' });
      showError(e);
    }
    finally {
      setBusy(false);
    }
  }
  return <Screen title="Connect laptop">
    <TextField
      label="Laptop address"
      editable={!busy}
      autoCapitalize="none"
      autoCorrect={false}
      value={address}
      onChangeText={value => { setAddress(value); setMessage(''); }}
      placeholder="http://100.x.y.z:8000"
    />
    <Button secondary label="Scan QR" disabled={busy} onPress={() => router.push('/scan')} />
    <TextField
      label="Server key"
      editable={!busy}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      value={key}
      onChangeText={value => { setKey(value); setMessage(''); }}
    />
    <Button large label="Connect" disabled={!address.trim() || retryAt > 0} loading={busy} onPress={() => void connect()} />
    {message && <Banner error message={message} />}
    {message.includes('not allowed') && <>
      <KeyValueRow label="Your user ID (hold to copy)" value={connection.check?.uid ?? uid} selectable />
      <Banner message="Add this ID to AUTH_ALLOWED_UIDS on the laptop." />
    </>}
    {health.data && <Collapsible title="Laptop details">
      <HealthPanel health={health.data} />
      {connection.check && <KeyValueRow label="Signed in as" value={connection.check.uid} selectable />}
    </Collapsible>}
  </Screen>;
}
