import { useState } from 'react';
import { router } from 'expo-router';
import { useConnectionStore } from '@/state/connectionStore';
import { useSettingsStore } from '@/state/settingsStore';
import { ServerClient } from '@/lib/server/client';
import type { Health } from '@/lib/server/types';
import type { LiveStatus } from '@/lib/live/streamClient';
import { withDeadline } from '@/lib/deadline';
import { t } from '@/i18n';
import { InlineNotice } from './InlineNotice';

export function ComputerNotice({ recorded, live, errorCode, processing = false }: { recorded: boolean; live?: LiveStatus; errorCode?: string | null; processing?: boolean }) {
  const connection = useConnectionStore(), [failed, setFailed] = useState(false);
  const safety = t(recorded ? 'safe' : 'nothingRecorded');
  if (connection.status === 'renew_required' || errorCode === 'account_not_allowed' || live === 'auth_required' || live === 'not_allowed') {
    return <InlineNotice title={t('computerSignIn')} safety={safety} action={t('connect')} onPress={() => router.push('/connect')} />;
  }
  if (processing && !['connected', 'verified'].includes(connection.status)) return <InlineNotice title={t('offlineProcessing')} safety={safety} action={t('connect')} onPress={() => router.push('/connect')} />;
  if (!connection.health || connection.health.model.status === 'ready') return null;
  return <InlineNotice title={t(failed ? 'connectionFailed' : 'modelStarting')} safety={safety} action={t('checkAgain')} onPress={() => {
    setFailed(false);
    const client = new ServerClient({ baseUrl: useSettingsStore.getState().serverUrl, getServerKey: async () => null, getBearer: async () => '', onAuthExpired: async () => {} });
    void withDeadline(client.get<Health>('/health', { auth: false })).then(health => connection.set({ health })).catch(() => setFailed(true));
  }} />;
}
