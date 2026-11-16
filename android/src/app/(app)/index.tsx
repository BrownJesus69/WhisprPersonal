import { useState } from 'react';
import { Alert, Linking, ScrollView, Text, View, KeyboardAvoidingView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSpeak } from '@/features/speak/useSpeak';
import { Button } from '@/components/Button';
import { TranscriptResult } from '@/components/ui/TranscriptResult';
import { MicButton } from '@/components/ui/MicButton';
import { LanguageChip } from '@/components/ui/LanguageChip';
import { LevelBars } from '@/components/ui/LevelBars';
import { StatusLabel } from '@/components/ui/StatusLabel';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { useTheme, typography } from '@/theme';
import { fontFor } from '@/theme/fonts';
import { t } from '@/i18n';
export default function Speak() {
  const s = useSpeak(), c = useTheme();
  const [actionError, setActionError] = useState('');
  const listening = s.state === 'listening';
  const processing = ['starting','stopping','processing','slow'].includes(s.state);
  const complete = s.state === 'complete' || s.state === 'failed' && s.session?.status === 'finalized';
  const time = Math.floor((s.recording.sessionId === s.session?.id ? s.recording.elapsedMs : s.session?.time_ms ?? 0) / 1000);
  const timer = `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toString().padStart(2, '0')}`;
  const act = (action: () => Promise<unknown>) => { void action().catch(() => setActionError(t('failed'))); };
  const openHistory = () => { if (s.session) router.push({ pathname: '/history/[sessionId]', params: { sessionId: s.session.id } }); };
  return <SafeAreaView edges={['top','left','right']} style={{ flex: 1, backgroundColor: c.background }}>
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, paddingHorizontal: 20, gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ ...typography.label, color: c.muted, fontFamily: fontFor(t('wordmark'), 600) }}>{t('wordmark')}</Text>
        <StatusLabel live={s.session ? s.live.status : undefined} />
      </View>
      <LanguageChip />
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 16, paddingVertical: 12 }}>
        {!!s.retentionNotice && <InlineNotice title={s.retentionNotice} safety={t('retentionSafe')} action={t('connect')} onPress={() => router.push('/connect')} />}
        {!!s.cleanupNotice && <InlineNotice title={s.cleanupNotice} safety={t('originalSafe')} action={t('connect')} onPress={() => router.push('/connect')} />}
        {s.interrupted && <InlineNotice title={t('interrupted')} safety={t('safe')} action={t('finish')} onPress={() => act(s.finish)} />}
        {s.state === 'permission_denied' && <InlineNotice title={t('permission')} safety={t('unsafe')} action={t('openSettings')} onPress={() => act(Linking.openSettings)} />}
        {s.state === 'failed' && <InlineNotice title={s.error || s.recording.message || t('failed')} safety={s.recording.phase === 'error' ? t('uncertain') : s.session?.consent_at ? t('safe') : t('unsafe')} action={s.error === t('otherRecording') ? t('openRecording') : s.recording.phase === 'error' ? t('stop') : t('retry')} onPress={() => { if (s.error === t('otherRecording') && s.recording.sessionId) router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.recording.sessionId } }); else act(s.recording.phase === 'error' ? s.stop : s.retry); }} />}
        {!!s.recording.warning && listening && <InlineNotice title={s.recording.warning} safety={t('safe')} action={t('stop')} onPress={() => act(s.stop)} />}
        {(s.state === 'processing' || s.state === 'slow') && s.disconnected && <InlineNotice title={t('offlineProcessing')} safety={t('safe')} action={t('connect')} onPress={() => router.push('/connect')} />}
        {s.state === 'slow' && !s.disconnected && <InlineNotice title={t('slow')} safety={t('safe')} action={t('openHistory')} onPress={openHistory} />}
        {(s.draftError || actionError) && <InlineNotice title={s.draftError ? t('draftFailed') : actionError} safety={s.draftError ? t('draftUnsafe') : t('safe')} action={t('retry')} onPress={() => { setActionError(''); act(s.flushDraft); }} />}
        {complete && s.session ? <TranscriptResult key={s.session.id} session={s.session} text={s.draft} edit={s.editDraft} cleaned={s.cleaned} changeCleaned={s.changeCleaned} hasPolished={s.rows.some(r => !!r.polished_text)} flush={s.flushDraft} remove={s.remove} /> : <>
          {[...s.live.model.finals.values()].map(row => <Text key={row.sequence} selectable style={{ ...typography.transcript, color: c.text, fontFamily: fontFor(row.raw_text) }}>{row.raw_text}</Text>)}
          {[...s.live.model.partials].map(([sequence, segments]) => <Text key={sequence} style={{ ...typography.transcript, color: c.muted, fontStyle: 'italic', fontFamily: fontFor(segments.map(v => v.text).join(' ')) }}>{segments.map(v => v.text).join(' ')}</Text>)}
          {!s.live.model.finals.size && !s.live.model.partials.size && <Text style={{ ...typography.transcript, color: c.muted, fontFamily: fontFor(t('support')) }}>{listening && s.live.status !== 'live' ? t('offlineRecording') : processing ? t('processing') : t('support')}</Text>}
        </>}
      </ScrollView>
      <View style={{ gap: 8, paddingVertical: 12, backgroundColor: c.background }}>
        <Text accessibilityRole="timer" style={{ ...typography.label, color: listening ? c.record : c.muted, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{listening ? `● ${t('listening', { time: timer })}` : t('computer')}</Text>
        <LevelBars recording={listening && s.recording.phase === 'recording'} />
        {!complete && <MicButton state={listening ? 'listening' : processing ? 'processing' : complete ? 'complete' : 'ready'} onPress={() => act(listening ? s.stop : s.start)} />}
        {complete && <Button secondary label={t('again')} onPress={() => act(s.start)} />}
        <View style={{ minHeight: 92, justifyContent: 'center' }}>
        {listening && <Button secondary label={t('cancel')} onPress={() => Alert.alert(t('cancelTitle'), undefined, [
          { text: t('backRecording'), style: 'cancel' }, { text: t('keep'), onPress: () => act(s.stop) }, { text: t('discard'), style: 'destructive', onPress: () => act(s.remove) }
        ])} />}

        </View>
      </View>
    </KeyboardAvoidingView>

  </SafeAreaView>;
}
