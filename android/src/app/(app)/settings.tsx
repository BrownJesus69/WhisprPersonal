import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { repositories } from '@/lib/db/repositories';
import { deleteAudio, recordingStorageBytes } from '@/lib/audio/chunkFiles';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { KeyValueRow } from '@/components/KeyValueRow';
import { SectionHeader } from '@/components/SectionHeader';
import { ChipSelect } from '@/components/ChipSelect';
import { ConnectionPill } from '@/components/ConnectionPill';
import { HealthPanel } from '@/components/HealthPanel';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useAuthStore } from '@/state/authStore';
import { LANGUAGES } from '@/types/models';
import { signOutAccount } from '@/lib/server/tokenManager';
import { config } from '@/lib/config';
import { integrations } from '@/features/integrations';

export default function Settings() {
  const s = useSettingsStore();
  const c = useConnectionStore();
  const user = useAuthStore(a => a.user);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const storage = useQuery({ queryKey: ['recording-storage', user?.uid], enabled: !!user,
    queryFn: async () => recordingStorageBytes(await (await repositories()).sessions(user!.uid)) });
  return <Screen title="Make it yours">
    <SectionHeader title="Laptop" />
    <KeyValueRow label="Server URL" value={s.serverUrl || 'Not connected'} />
    <ConnectionPill />
    <SectionHeader title="Session defaults" />
    <Banner message="Audio is recorded at 16 kHz mono PCM. Chunk length and overlap apply to new sessions. Cleanup is off by default; raw transcripts are retained." />
    <KeyValueRow label="Default language mode" value={s.defaultLanguageMode} />
    <ChipSelect options={[{ value: 'auto', label: 'Auto' }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))]} selected={[s.defaultLanguageMode]} onSelect={value => s.set({ defaultLanguageMode: value })} />
    <SectionHeader title="Audio quality" />
    <ChipSelect options={(['low', 'standard', 'high'] as const).map(value => ({ value, label: value }))} selected={[s.audioQuality]} onSelect={value => s.set({ audioQuality: value })} />
    <KeyValueRow label="Chunk length" value={`${s.chunkSeconds} seconds (5–15)`} />
    <Button
      secondary
      label="Shorter chunk"
      disabled={s.chunkSeconds <= 5}
      onPress={() => s.set({ chunkSeconds: s.chunkSeconds - 1 })}
    />
    <Button
      secondary
      label="Longer chunk"
      disabled={s.chunkSeconds >= 15}
      onPress={() => s.set({ chunkSeconds: s.chunkSeconds + 1 })}
    />
    <KeyValueRow label="Overlap" value={`${s.overlapMs} ms (1000–1500)`} />
    <Button
      secondary
      label="Less overlap"
      disabled={s.overlapMs <= 1000}
      onPress={() => s.set({ overlapMs: s.overlapMs - 100 })}
    />
    <Button
      secondary
      label="More overlap"
      disabled={s.overlapMs >= 1500}
      onPress={() => s.set({ overlapMs: s.overlapMs + 100 })}
    />
    <SectionHeader title="Cleanup level" />
    <ChipSelect options={(['none', 'conservative', 'polished'] as const).map(value => ({ value, label: value }))} selected={[s.cleanupLevel]} onSelect={value => s.set({ cleanupLevel: value })} />
    <SectionHeader title="Privacy mode" />
    <ChipSelect options={[{ value: 'local_only', label: 'Local only' }, { value: 'cloud_ai', label: 'Cloud AI enabled' }]} selected={[s.privacyMode]} onSelect={value => s.set({ privacyMode: value })} />
    <SectionHeader title="Phone audio storage" />
    {storage.error && <Banner error message="Could not calculate recording storage." />}
    <KeyValueRow label="Recordings on this account" value={storage.data === undefined ? 'Checking…' : `${(storage.data / 1024 ** 2).toFixed(1)} MB`} />
    <KeyValueRow label="Delete phone audio after the laptop transcribes it" value={s.deleteLocalAudioAfterTranscription ? 'On' : 'Off'} />
    <Switch accessibilityLabel="Delete phone audio after the laptop transcribes it" value={s.deleteLocalAudioAfterTranscription} onValueChange={value => s.set({ deleteLocalAudioAfterTranscription: value })} />
    <Banner message="Only transcribed chunk files are deleted. Master recordings remain on the phone." />
    <Button secondary label="Delete transcribed chunk audio now" loading={busy} onPress={() => Alert.alert('Delete transcribed chunk audio?', 'Master recordings and audio awaiting transcription will be kept.', [
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
    ])} />
    <SectionHeader title="Account" />
    <Card>
      <KeyValueRow label="Email" value={user?.email} />
      <KeyValueRow label="Provider" value={user?.provider} />
      <KeyValueRow label="UID (hold to copy)" value={user?.uid} selectable />
    </Card>
    {message && <Banner error={message !== 'Transcribed chunk audio deleted.'} message={message} />}
    <Button
      secondary
      label="Sign out"
      loading={busy}
      onPress={() => {
        setBusy(true);
        void signOutAccount().catch(() => setMessage('Could not sign out. Please try again.')).finally(() => setBusy(false));
      }}
    />
    <SectionHeader title="Diagnostics" />
    <KeyValueRow label="App version" value={config.version} />
    <KeyValueRow label="Expo SDK" value={config.sdk} />
    <KeyValueRow label="Offline pass valid until" value={c.passExpiry ? new Date(c.passExpiry * 1000).toLocaleString() : 'No pass'} />
    {c.health ? <HealthPanel health={c.health} /> : <Banner message="Test the laptop connection to see diagnostics." />}
    <SectionHeader title="Future integrations" />
    {integrations.map(i => <KeyValueRow key={i.name} label={i.name} value={i.status} />)}
  </Screen>;
}
