import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch, Text } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { TranslationAPI } from '@/lib/translation/api';
import { authedClient } from '@/lib/server/authedClient';
import { translationDiagnostics } from '@/lib/export/diagnostics';
import { repositories } from '@/lib/db/repositories';
import { deleteAudio } from '@/lib/audio/chunkFiles';
import { removeRecording } from '@/features/speak/retention';
import { speakEventId } from '@/features/speak/speakEvent';
import { useAI } from '@/hooks/useAI';
import { unavailableReason } from '@/lib/ai/messages';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { ButtonRow } from '@/components/ButtonRow';
import { Collapsible } from '@/components/Collapsible';
import { KeyValueRow } from '@/components/KeyValueRow';
import { ChipSelect } from '@/components/ChipSelect';
import { HealthPanel } from '@/components/HealthPanel';
import { SettingsGroup } from '@/components/ui/SettingsGroup';
import { SettingsRow } from '@/components/ui/SettingsRow';
import { LanguageSheet } from '@/components/ui/LanguageChip';
import { StatusLabel } from '@/components/ui/StatusLabel';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { useSettingsStore } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useAuthStore } from '@/state/authStore';
import { signOutAccount } from '@/lib/server/tokenManager';
import { config } from '@/lib/config';
import { integrationStatuses } from '@/features/integrations';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

export default function Settings() {
  const s = useSettingsStore(), c = useConnectionStore(), user = useAuthStore(a => a.user), colors = useTheme();
  const [language, setLanguage] = useState(false), [message, setMessage] = useState(''), [problem, setProblem] = useState(false), [busy, setBusy] = useState(false);
  const connected = ['connected', 'verified'].includes(c.status);
  const ai = useAI(user?.uid, user ? speakEventId(user.uid) : undefined);
  const unavailable = unavailableReason(s.serverUrl, connected ? ai.status.data : undefined, s.privacyMode);
  const translation = useQuery({ queryKey: ['translation-status', user?.uid, s.serverUrl], enabled: !!user && connected, retry: false, refetchInterval: 30000, queryFn: async () => {
    const client = authedClient(user!.uid); if (!client) throw new Error('Offline'); return new TranslationAPI(client).status();
  } });
  const report = (value: string, failed = false) => { setMessage(value); setProblem(failed); };
  const freeUpSpace = () => Alert.alert(t('freeTitle'), t('freeBody'), [
    { text: t('cancel'), style: 'cancel' }, { text: t('deleteAudio'), style: 'destructive', onPress: () => {
      setBusy(true);
      void (async () => {
        if (!user) return;
        const repo = await repositories();
        for (const session of await repo.sessions(user.uid)) for (const chunk of await repo.chunks(session.id)) if (chunk.status === 'transcribed' && !chunk.local_deleted) {
          deleteAudio(chunk.uri); await repo.updateChunk(chunk.chunk_id, { local_deleted: 1 });
        }
        report(t('freeDone'));
      })().catch(() => report(t('freeFailed'), true)).finally(() => setBusy(false));
    } }
  ]);
  const deleteAll = () => Alert.alert(t('deleteAllTitle'), t('deleteAllBody'), [
    { text: t('cancel'), style: 'cancel' }, { text: t('deleteAll'), style: 'destructive', onPress: () => {
      if (!user) return;
      setBusy(true);
      void (async () => {
        let deleted = 0, pending = 0, failed = 0;
        for (const session of await (await repositories()).sessions(user.uid)) {
          try { const result = await removeRecording(user.uid, session.id); if (result.pending) pending++; else deleted++; }
          catch { failed++; }
        }
        report([t('deletedCount', { deleted, pending, failed }), pending ? t('deletePending') : '', failed ? t('deleteFailedSafe') : ''].filter(Boolean).join(' '), failed > 0 || pending > 0);
      })().catch(() => report(t('deleteFailedSafe'), true)).finally(() => setBusy(false));
    } }
  ]);
  return <Screen title={t('settings')}>
    <SettingsGroup title={t('speech')}>
      <SettingsRow title={t('language')} description={t(s.defaultLanguageMode)} onPress={() => setLanguage(true)} />
      <SettingsRow title={t('recognition')} description={t('computer')} onPress={() => router.push('/connect')}><StatusLabel onPress={() => router.push('/connect')} /></SettingsRow>
      <SettingsRow title={t('textCleanup')} description={t(s.cleanupLevel === 'none' ? 'original' : 'cleanupDefault')}><Switch style={{ minHeight: 48, minWidth: 48 }} accessibilityLabel={t('textCleanup')} accessibilityState={{ disabled: !!unavailable }} disabled={!!unavailable} value={s.cleanupLevel !== 'none'} onValueChange={value => s.set({ cleanupLevel: value ? 'conservative' : 'none' })} /></SettingsRow>
      <Text style={{ ...typography.caption, color: colors.muted }}>{t(unavailable ? 'notSetUpComputer' : 'cleanupAvailable')}</Text>
      <SettingsRow title={t('personalWords')} description={t('personalWordsHelp')} onPress={() => router.push('/personal-words')} />
    </SettingsGroup>
    <SettingsGroup title={t('privacy')}>
      <SettingsRow title={t('keepTranscripts')} description={t('keepHelp')}><Switch style={{ minHeight: 48, minWidth: 48 }} accessibilityLabel={t('keepTranscripts')} value={s.keepTranscripts} onValueChange={keepTranscripts => s.set({ keepTranscripts })} /></SettingsRow>
      {!s.keepTranscripts && <Text style={{ ...typography.caption, color: colors.muted }}>{t('retentionHelp')}</Text>}
      <SettingsRow title={t('deletePhoneAfter')} description={t('deletePhoneAfterHelp')}><Switch style={{ minHeight: 48, minWidth: 48 }} accessibilityLabel={t('deletePhoneAfter')} value={s.deleteLocalAudioAfterTranscription} onValueChange={value => s.set({ deleteLocalAudioAfterTranscription: value })} /></SettingsRow>
      <Button secondary label={t('freeSpace')} loading={busy} onPress={freeUpSpace} />
      <Button secondary label={t('deleteAll')} disabled={busy} onPress={deleteAll} />
      {!!message && (problem ? <InlineNotice title={message} safety={t('deleteFailedSafe')} action={t('connect')} onPress={() => router.push('/connect')} /> : <Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: colors.muted }}>{message}</Text>)}
    </SettingsGroup>
    <SettingsGroup title={t('appearance')}><ChipSelect options={(['system', 'light', 'dark'] as const).map(value => ({ value, label: t(value) }))} selected={[s.appearance]} onSelect={appearance => s.set({ appearance })} /></SettingsGroup>
    <SettingsGroup title={t('account')}>
      <SettingsRow title={user?.email ?? t('signedIn')} />
      <Button secondary label={t('signOut')} loading={busy} onPress={() => { setBusy(true); void signOutAccount().catch(() => report(t('signOutFailed'), true)).finally(() => setBusy(false)); }} />
    </SettingsGroup>
    <Collapsible title={t('advanced')}>
      <SettingsRow title={t('computerAddress')} description={s.serverUrl || t('disconnected')} onPress={() => router.push('/connect')} />
      <KeyValueRow label={t('passUntil')} value={c.passExpiry ? new Date(c.passExpiry * 1000).toLocaleString() : t('noPass')} />
      <KeyValueRow label={t('audioQuality')} value={t(s.audioQuality)} />
      <ChipSelect options={(['low', 'standard', 'high'] as const).map(value => ({ value, label: t(value) }))} selected={[s.audioQuality]} onSelect={audioQuality => s.set({ audioQuality })} />
      <KeyValueRow label={t('chunkLength')} value={t('chunkValue', { count: s.chunkSeconds })} />
      <ButtonRow><Button secondary label={t('shorterChunk')} disabled={s.chunkSeconds <= 5} onPress={() => s.set({ chunkSeconds: s.chunkSeconds - 1 })} /><Button secondary label={t('longerChunk')} disabled={s.chunkSeconds >= 15} onPress={() => s.set({ chunkSeconds: s.chunkSeconds + 1 })} /></ButtonRow>
      <KeyValueRow label={t('overlap')} value={t('overlapValue', { count: s.overlapMs })} />
      <ButtonRow><Button secondary label={t('lessOverlap')} disabled={s.overlapMs <= 1000} onPress={() => s.set({ overlapMs: s.overlapMs - 100 })} /><Button secondary label={t('moreOverlap')} disabled={s.overlapMs >= 1500} onPress={() => s.set({ overlapMs: s.overlapMs + 100 })} /></ButtonRow>
      <Text style={{ ...typography.caption, color: colors.muted }}>{t('recordingTechnical')}</Text>
      <KeyValueRow label={t('cleanupLevel')} value={t(s.cleanupLevel === 'none' ? 'original' : s.cleanupLevel)} />
      <ButtonRow>{(['none', 'conservative', 'polished'] as const).map(value => <Button key={value} secondary selected={s.cleanupLevel === value} label={t(value === 'none' ? 'original' : value)} disabled={!!unavailable} onPress={() => s.set({ cleanupLevel: value })} />)}</ButtonRow>
      <SettingsRow title={t('cloudAI')} description={t('cloudHelp')}><Switch style={{ minHeight: 48, minWidth: 48 }} accessibilityLabel={t('cloudAI')} value={s.privacyMode === 'cloud_ai'} onValueChange={value => s.set({ privacyMode: value ? 'cloud_ai' : 'local_only' })} /></SettingsRow>
      <Button secondary label={t('openDiagnostics')} onPress={() => router.push('/diagnostics')} />
      <KeyValueRow label={t('userID')} value={user?.uid} selectable />
      <KeyValueRow label={t('signInMethod')} value={user?.provider} />
      <KeyValueRow label={t('expoSDK')} value={config.sdk} />
      {c.health ? <HealthPanel health={c.health} /> : <Text style={{ ...typography.body, color: colors.muted }}>{t('connectDetails')}</Text>}
      <SettingsGroup title={t('translationHeading')}>{translationDiagnostics(connected ? translation.data ?? c.health?.translation : undefined).map(r => <KeyValueRow key={r.label} {...r} />)}</SettingsGroup>
      <SettingsGroup title={t('integrationsHeading')}>{integrationStatuses(connected ? c.health : null).map(i => <KeyValueRow key={i.name} label={i.name} value={`${i.status} · ${i.explanation}`} />)}</SettingsGroup>
    </Collapsible>
    <SettingsGroup title={t('about')}>
      <SettingsRow title={t('version')} description={config.version} />
      <SettingsRow title={t('licenses')} description={t('licensesHelp')} onPress={() => router.push('/licenses')} />
      <SettingsRow title={t('privacy')} description={t('privacyHelp')} onPress={() => router.push('/privacy-info')} />
      <SettingsRow title={t('resumeSetup')} onPress={() => router.push('/setup')} />
    </SettingsGroup>
    <LanguageSheet visible={language} close={() => setLanguage(false)} />
  </Screen>;
}
