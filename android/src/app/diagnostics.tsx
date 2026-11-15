import { TranslationAPI } from '@/lib/translation/api';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { Paths } from 'expo-file-system';
import { getNetworkStateAsync } from 'expo-network';
import { repositories } from '@/lib/db/repositories';
import { authedClient } from '@/lib/server/authedClient';
import { phoneDiagnostics, laptopDiagnostics, diagnosticsText } from '@/lib/export/diagnostics';
import { shareDocument } from '@/lib/export/share';
import { useAuthStore } from '@/state/authStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { SectionHeader } from '@/components/SectionHeader';
import { KeyValueRow } from '@/components/KeyValueRow';
import { Button } from '@/components/Button';
export default function Diagnostics() {
  const uid = useAuthStore(s => s.user?.uid), url = useSettingsStore(s => s.serverUrl), expiry = useConnectionStore(s => s.passExpiry);
  const [message,setMessage] = useState(''), [busy,setBusy] = useState(false);
  const phone = useQuery({ queryKey: ['phone-diagnostics',uid,url,expiry], enabled: !!uid, queryFn: async () => {
    const network = await getNetworkStateAsync();
    return phoneDiagnostics(await repositories(),uid!,{ version: Constants.expoConfig?.version ?? 'Unknown', versionCode: Constants.expoConfig?.android?.versionCode,
      serverUrl: url, passExpiry: expiry, network: network.isConnected === false ? 'Offline' : network.isConnected ? 'Connected' : 'Unknown', available: Paths.availableDiskSpace, total: Paths.totalDiskSpace });
  } });
  const laptop = useQuery({ queryKey: ['laptop-diagnostics',uid,url], enabled: !!uid && !!url, retry: false, queryFn: async () => {
    const client = authedClient(uid!); if (!client) throw new Error('Unavailable');
    const [data, translation] = await Promise.all([client.get<Record<string,unknown>>('/api/v1/diagnostics'), new TranslationAPI(client).status().catch(() => undefined)]);
    return laptopDiagnostics({ ...data, translation: translation ?? data.translation });
  } });
  return <Screen title="Diagnostics">
    <Banner message="Diagnostics contain status and counts. Transcript text, notes, keys, tokens and device identifiers are excluded." />
    <SectionHeader title="Laptop" />
    {(!url || laptop.error) && <Banner message="Laptop unavailable. Connect to view laptop diagnostics." />}
    {url && laptop.isPending && <Banner message="Checking laptop..." />}
    {laptop.data?.map(r => <KeyValueRow key={r.label} {...r} />)}
    <SectionHeader title="Phone" />
    {phone.isPending && <Banner message="Checking phone storage and local counts..." />}
    {phone.error && <Banner error message="Phone diagnostics unavailable. Try refresh." />}
    {phone.data?.map(r => <KeyValueRow key={r.label} {...r} />)}
    <Button secondary label="Refresh diagnostics" onPress={() => { void phone.refetch(); if (url) void laptop.refetch(); }} />
    {message && <Banner message={message} />}
    <Button label="Share diagnostics" loading={busy} disabled={!phone.data} onPress={() => {
      setBusy(true); setMessage('');
      void shareDocument({ filename: 'whisprpersonal-diagnostics.txt', mimeType: 'text/plain', content: diagnosticsText(phone.data!,laptop.data ?? []) })
        .then(() => setMessage('Diagnostics opened in the share sheet.')).catch(() => setMessage('Could not share diagnostics. Check sharing availability and phone storage.')).finally(() => setBusy(false));
    }} />
  </Screen>;
}
