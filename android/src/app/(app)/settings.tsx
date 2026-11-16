import { t as text } from '@/i18n';
import { TranslationAPI } from '@/lib/translation/api';
import { authedClient } from '@/lib/server/authedClient';
import { translationDiagnostics } from '@/lib/export/diagnostics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { repositories } from '@/lib/db/repositories';
import { deleteAudio, recordingStorageBytes } from '@/lib/audio/chunkFiles';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { ButtonRow } from '@/components/ButtonRow';
import { Card } from '@/components/Card';
import { Collapsible } from '@/components/Collapsible';
import { KeyValueRow } from '@/components/KeyValueRow';
import { SectionHeader } from '@/components/SectionHeader';
import { ChipSelect } from '@/components/ChipSelect';
import { ConnectionPill } from '@/components/ConnectionPill';
import { HealthPanel } from '@/components/HealthPanel';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useAuthStore } from '@/state/authStore';
import { LANGUAGE_MODE_OPTIONS } from '@/types/models';
import { signOutAccount } from '@/lib/server/tokenManager';
import { config } from '@/lib/config';
import { integrationStatuses } from '@/features/integrations';
import { useTheme, typography } from '@/theme';

/** A label, its current value, and − / + buttons. */
function Stepper({ label, value, labels, minus, plus }: {
  label: string; value: string; labels: [string, string]; minus?: () => void; plus?: () => void;
}) {
  return <>
    <KeyValueRow label={label} value={value} />
    <ButtonRow>
      <Button secondary label={labels[0]} disabled={!minus} onPress={() => minus?.()} />
      <Button secondary label={labels[1]} disabled={!plus} onPress={() => plus?.()} />
    </ButtonRow>
  </>;
}

export default function Settings() {
  const s = useSettingsStore();
  const c = useConnectionStore();
  const user = useAuthStore(a => a.user);
  const t = useTheme();
  const connected = ['connected','verified'].includes(c.status);
  const translation = useQuery({ queryKey: ['translation-status',user?.uid,s.serverUrl], enabled: !!user && connected, retry: false, refetchInterval: 30000, queryFn: async () => {
    const client = authedClient(user!.uid); if (!client) throw new Error('Offline'); return new TranslationAPI(client).status();
  } });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const storage = useQuery({ queryKey: ['recording-storage', user?.uid], enabled: !!user,
    queryFn: async () => recordingStorageBytes(await (await repositories()).sessions(user!.uid)) });
  const freeUpSpace = () => Alert.alert('Free up space?', 'Deletes phone copies of audio the laptop has already transcribed. Full recordings and audio still waiting to upload are kept.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => {
      setBusy(true);
      void (async () => {
        if (!user) return;
        const repo = await repositories();
        for (const session of await repo.sessions(user.uid)) for (const chunk of await repo.chunks(session.id)) if (chunk.status === 'transcribed' && !chunk.local_deleted) {
          deleteAudio(chunk.uri); await repo.updateChunk(chunk.chunk_id, { local_deleted: 1 });
        }
        await storage.refetch(); setMessage('Transcribed chunk audio deleted.');
      })().catch(() => setMessage('Could not delete all transcribed chunks. Please try again.')).finally(() => setBusy(false));
    } }
  ]);
  return <Screen title="Settings">
    <SectionHeader title={text('appearance')} />
    <ChipSelect options={(['system','light','dark'] as const).map(value => ({ value, label: text(value) }))} selected={[s.appearance]} onSelect={appearance => s.set({ appearance })} />
    <SectionHeader title="Laptop" />
    <ConnectionPill />
    {!!s.serverUrl && <Text selectable style={{ ...typography.body, color: t.muted }}>{s.serverUrl}</Text>}

    <SectionHeader title="Account" />
    <Text selectable style={{ ...typography.body, color: t.text }}>{user?.email ?? 'Signed in'}</Text>
    <Button
      secondary
      label="Sign out"
      loading={busy}
      onPress={() => {
        setBusy(true);
        void signOutAccount().catch(() => setMessage('Could not sign out. Please try again.')).finally(() => setBusy(false));
      }}
    />

    <SectionHeader title="Phone storage" />
    {storage.error && <Banner error message="Could not calculate recording storage." />}
    <KeyValueRow label="Recordings on this phone" value={storage.data === undefined ? 'Checking…' : `${(storage.data / 1024 ** 2).toFixed(1)} MB`} />
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ ...typography.body, color: t.text, flex: 1 }}>Auto-delete phone audio once transcribed</Text>
      <Switch accessibilityLabel="Delete phone audio after the laptop transcribes it" value={s.deleteLocalAudioAfterTranscription} onValueChange={value => s.set({ deleteLocalAudioAfterTranscription: value })} />
    </View>
    <Button secondary label="Free up space now" loading={busy} onPress={freeUpSpace} />
    {message && <Banner error={message !== 'Transcribed chunk audio deleted.'} message={message} />}

    <Collapsible title="Advanced">
      <SectionHeader title="Recording" />
      <KeyValueRow label="Default language" value={LANGUAGE_MODE_OPTIONS.find(o => o.value === s.defaultLanguageMode)?.label} />
      <ChipSelect options={LANGUAGE_MODE_OPTIONS} selected={[s.defaultLanguageMode]} onSelect={value => s.set({ defaultLanguageMode: value })} />
      <KeyValueRow label="Audio quality" value={s.audioQuality} />
      <ChipSelect options={(['low', 'standard', 'high'] as const).map(value => ({ value, label: value }))} selected={[s.audioQuality]} onSelect={value => s.set({ audioQuality: value })} />
      <Stepper label="Chunk length" value={`${s.chunkSeconds} seconds`} labels={['Shorter chunk', 'Longer chunk']}
        minus={s.chunkSeconds > 5 ? () => s.set({ chunkSeconds: s.chunkSeconds - 1 }) : undefined}
        plus={s.chunkSeconds < 15 ? () => s.set({ chunkSeconds: s.chunkSeconds + 1 }) : undefined} />
      <Stepper label="Overlap" value={`${s.overlapMs} ms`} labels={['Less overlap', 'More overlap']}
        minus={s.overlapMs > 1000 ? () => s.set({ overlapMs: s.overlapMs - 100 }) : undefined}
        plus={s.overlapMs < 1500 ? () => s.set({ overlapMs: s.overlapMs + 100 }) : undefined} />
      <Banner message="Audio is 16 kHz mono. Chunk length and overlap apply to new recordings." />
      <SectionHeader title="AI" />
      <KeyValueRow label="Transcript cleanup (raw transcript is always kept)" value={s.cleanupLevel} />
      <ChipSelect options={(['none', 'conservative', 'polished'] as const).map(value => ({ value, label: value }))} selected={[s.cleanupLevel]} onSelect={value => s.set({ cleanupLevel: value })} />
      <KeyValueRow label="Privacy for new events" value={s.privacyMode === 'cloud_ai' ? 'Cloud AI allowed' : 'Local only'} />
      <ChipSelect options={[{ value: 'local_only', label: 'Local only' }, { value: 'cloud_ai', label: 'Cloud AI allowed' }]} selected={[s.privacyMode]} onSelect={value => s.set({ privacyMode: value })} />
      <SectionHeader title="Diagnostics" />
      <Button secondary label="Open diagnostics" onPress={() => router.push('/diagnostics')} />
      <Card>
        <KeyValueRow label="User ID (hold to copy)" value={user?.uid} selectable />
        <KeyValueRow label="Sign-in method" value={user?.provider} />
        <KeyValueRow label="Offline pass valid until" value={c.passExpiry ? new Date(c.passExpiry * 1000).toLocaleString() : 'No pass'} />
        <KeyValueRow label="Expo SDK" value={config.sdk} />
      </Card>
      {c.health ? <HealthPanel health={c.health} /> : <Banner message="Connect the laptop to see its details." />}
      <SectionHeader title="Translation (on your laptop)" />
      {translationDiagnostics(connected ? translation.data ?? c.health?.translation : undefined).map(r => <KeyValueRow key={r.label} {...r} />)}
      <SectionHeader title="Future integrations" />
      {integrationStatuses(connected ? c.health : null).map(i => <KeyValueRow key={i.name} label={i.name} value={`${i.status} · ${i.explanation}`} />)}
    </Collapsible>
    <Text style={{ ...typography.label, color: t.muted }}>WhisprPersonal {config.version}</Text>
  </Screen>;
}
