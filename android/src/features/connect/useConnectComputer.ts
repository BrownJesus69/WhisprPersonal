import { syncKeyboard } from '@/features/keyboard/syncKeyboard';
import { useEffect, useState } from 'react';
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
import { t } from '@/i18n';
export type ConnectionCheck = 'waiting' | 'checking' | 'passed' | 'failed';
export function useConnectComputer(onConnected?: (ready: boolean) => void) {
  const [checks, setChecks] = useState<ConnectionCheck[]>(['waiting', 'waiting', 'waiting']);
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
    void credentials.getServerKey().then(value => setKey(value ?? '')).catch(() => setMessage(t('keyStorageFailed')));
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
      : error instanceof Error ? error.message : t('connectionFailed'));
  }
  async function connect() {
    if (busy || retryAt > Date.now())
      return;
    setBusy(true);
    setMessage('');
    setChecks(['checking', 'waiting', 'waiting']);
    connection.set({ status: 'testing', check: null, passExpiry: null });
    try {
      const url = parseServerUrl(address).url;
      const result = await health.mutateAsync(url);
      setChecks(['passed', 'checking', 'waiting']);
      connection.set({ health: result, status: 'verifying' });
      if (!key.trim())
        throw new Error(t('enterServerKey'));
      await credentials.setServerKey(key.trim());
      connection.set({ check: await check.mutateAsync(url) });
      setChecks(['passed', 'passed', result.model.status === 'ready' ? 'passed' : 'failed']);
      if (result.auth.grants.enabled)
        await createTokenManager(url).ensurePass();
      settings.set({ serverUrl: url });
      await syncKeyboard().catch(() => setMessage(t('keyboardSyncFailed')));
      connection.set({ status: 'connected' });
      onConnected?.(result.model.status === 'ready');
    }
    catch (e) {
      setChecks(current => current.map(step => step === 'checking' ? 'failed' : step));
      connection.set({ status: e instanceof ServerError && e.code === 'auth_token_expired' ? 'renew_required' : 'error' });
      showError(e);
    }
    finally {
      setBusy(false);
    }
  }
  return { address, setAddress, key, setKey, message, setMessage, busy, retryAt, health, checks, connect, connection, uid };
}
