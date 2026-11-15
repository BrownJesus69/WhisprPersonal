import { useState } from 'react';
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
  return <Screen title="Make it yours">
    <SectionHeader title="Laptop" />
    <KeyValueRow label="Server URL" value={s.serverUrl || 'Not connected'} />
    <ConnectionPill />
    <SectionHeader title="Session defaults" />
    <Banner message="Recording settings take effect when recording arrives in Phase 5. Cleanup is off by default; raw transcripts are retained." />
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
    <SectionHeader title="Account" />
    <Card>
      <KeyValueRow label="Email" value={user?.email} />
      <KeyValueRow label="Provider" value={user?.provider} />
      <KeyValueRow label="UID (hold to copy)" value={user?.uid} selectable />
    </Card>
    {message && <Banner error message={message} />}
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
