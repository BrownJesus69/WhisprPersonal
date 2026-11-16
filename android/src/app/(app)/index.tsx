import { useConnectionStore } from '@/state/connectionStore';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { RecognitionNotice } from '@/components/ui/RecognitionNotice';
import { captionsAvailable } from '@/features/speak/captions';
import { CleanupNotice } from '@/components/ui/CleanupNotice';
import { ComputerNotice } from '@/components/ui/ComputerNotice';
import { useSettingsStore } from '@/state/settingsStore';
import { useRef, useState } from 'react';
import { Alert, Linking, ScrollView, TextInput, Text, View, KeyboardAvoidingView } from 'react-native';
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
import { fontFor, lineHeightFor } from '@/theme/fonts';
import { t } from '@/i18n';
export default function Speak() {
  const s = useSpeak(), c = useTheme();
  const dismissed = useSettingsStore(state => state.keyboardPromptDismissed);
  const [more, setMore] = useState(false);
  const connection = useConnectionStore();
  const [actionError, setActionError] = useState('');
  const listening = s.state === 'listening';
  const processing = ['starting','stopping','processing','slow'].includes(s.state);
  const complete = s.state === 'complete' || s.state === 'failed' && !!s.rows.length;
  const time = Math.floor((s.recording.sessionId === s.session?.id ? s.recording.elapsedMs : s.session?.time_ms ?? 0) / 1000);
  const timer = `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toString().padStart(2, '0')}`;
  const retryAction = useRef<() => Promise<unknown>>(async () => {});
  const act = (action: () => Promise<unknown>) => { retryAction.current = action; setActionError(''); void action().catch(() => setActionError(t('failed'))); };
  const openHistory = () => { if (s.session) router.push({ pathname: '/history/[sessionId]', params: { sessionId: s.session.id } }); };
  return <SafeAreaView edges={['top','left','right']} style={{ flex: 1, backgroundColor: c.background }}>
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, paddingHorizontal: 20, gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ ...typography.label, color: c.muted, fontFamily: fontFor(t('wordmark'), 600) }}>{t('wordmark')}</Text>
        <StatusLabel live={s.session ? s.live.status : undefined} />
        {!complete && captionsAvailable(connection.status, connection.health, s.live.status) && <Button secondary label={t('more')} onPress={() => setMore(true)} />}
      </View>
      <LanguageChip />
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 16, paddingVertical: 12 }}>
        {!!s.retentionNotice && <InlineNotice title={s.retentionNotice} safety={t('retentionSafe')} action={t('connect')} onPress={() => router.push('/connect')} />}
        {!!s.cleanupNotice && (s.session && s.cleanupNotice === t('cleanupFailed') ? <CleanupNotice session={s.session} /> : <InlineNotice title={s.cleanupNotice} safety={t('originalSafe')} action={t('connect')} onPress={() => router.push('/connect')} />)}
        <RecognitionNotice session={s.session} rows={s.rows} again={() => act(s.start)} />
        {s.interrupted && <InlineNotice title={t('interrupted')} safety={t('safe')} action={t('finish')} onPress={() => act(s.finish)} />}
        {s.state === 'permission_denied' && <InlineNotice title={t('permission')} safety={t('nothingRecorded')} action={t('openSettings')} onPress={() => act(Linking.openSettings)} />}
        {s.state === 'microphone_unavailable' && <InlineNotice title={t('micBusy')} safety={t('nothingRecorded')} action={t('retry')} onPress={() => act(s.start)} />}
        {s.state === 'failed' && s.session?.status !== 'failed' && <InlineNotice title={s.error || t('recordingSaveFailed')} safety={s.recording.phase === 'error' ? t('uncertain') : s.session?.consent_at ? t('safe') : t('unsafe')} action={s.error === t('otherRecording') ? t('openRecording') : s.recording.phase === 'error' ? t('stop') : t('retry')} onPress={() => { if (s.error === t('otherRecording') && s.recording.sessionId) router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.recording.sessionId } }); else act(s.recording.phase === 'error' ? s.stop : s.retry); }} />}
        {!!s.recording.warning && listening && <InlineNotice title={t('recordingWarning')} safety={t('safe')} action={t('stop')} onPress={() => act(s.stop)} />}
        <ComputerNotice recorded={!!s.session?.consent_at && !!s.session.master_uri} live={s.live.status} errorCode={s.session?.last_error} />
        {(s.state === 'processing' || s.state === 'slow') && s.disconnected && <InlineNotice title={t('offlineProcessing')} safety={t('safe')} action={t('connect')} onPress={() => router.push('/connect')} />}
        {s.state === 'slow' && !s.disconnected && <InlineNotice title={t('slow')} safety={t('safe')} action={t('openHistory')} onPress={openHistory} />}
        {(s.draftError || actionError) && <InlineNotice title={s.draftError ? t('draftFailed') : actionError} safety={s.draftError ? t('draftUnsafe') : s.session?.consent_at && s.session.master_uri ? t('safe') : t('nothingRecorded')} action={t('retry')} onPress={() => { setActionError(''); act(s.draftError ? s.flushDraft : retryAction.current); }} />}
        {s.state === 'complete' && !!s.draft.trim() && !dismissed && <View>
          <Button secondary label={t('keyboardOtherApps')} onPress={() => { useSettingsStore.getState().set({ keyboardPromptDismissed: true }); router.push('/keyboard-setup'); }} />
          <Button secondary label={t('keyboardDismiss')} onPress={() => useSettingsStore.getState().set({ keyboardPromptDismissed: true })} />
        </View>}
        {complete && s.session ? <TextInput multiline accessibilityLabel={t('transcript')} value={s.draft} onChangeText={s.editDraft} textAlignVertical="top" style={{ ...typography.transcript, color: c.text, fontFamily: fontFor(s.draft), lineHeight: lineHeightFor(s.draft, 19), minHeight: 160 }} /> : <>
          {[...s.live.model.finals.values()].map(row => <Text key={row.sequence} selectable style={{ ...typography.transcript, color: c.text, fontFamily: fontFor(row.raw_text), lineHeight: lineHeightFor(row.raw_text, 19) }}>{row.raw_text}</Text>)}
          {[...s.live.model.partials].map(([sequence, segments]) => <Text key={sequence} style={{ ...typography.transcript, color: c.muted, fontStyle: 'italic', fontFamily: fontFor(segments.map(v => v.text).join(' ')), lineHeight: lineHeightFor(segments.map(v => v.text).join(' '), 19) }}>{segments.map(v => v.text).join(' ')}</Text>)}
          {!s.live.model.finals.size && !s.live.model.partials.size && <Text style={{ ...typography.transcript, color: c.muted, fontFamily: fontFor(t('support')) }}>{listening && s.live.status !== 'live' ? t('offlineRecording') : processing ? t('processing') : t('support')}</Text>}
        </>}
      </ScrollView>
      <View testID="speak-dock" style={{ gap: 8, paddingVertical: 12, backgroundColor: c.background }}>
        <Text accessibilityLiveRegion="none" importantForAccessibility="no" style={{ ...typography.label, color: listening ? c.record : c.muted, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{listening ? `● ${t('listening', { time: timer })}` : t('computer')}</Text>
        <LevelBars recording={listening && s.recording.phase === 'recording'} />
        {!complete && <MicButton elapsed={t('listening', { time: timer })} state={listening ? 'listening' : processing ? 'processing' : complete ? 'complete' : 'ready'} onPress={() => act(listening ? s.stop : s.start)} />}
        {complete && <Button secondary label={t('again')} onPress={() => act(s.start)} />}
        {complete && s.session && <TranscriptResult hideEditor key={s.session.id} session={s.session} text={s.draft} edit={s.editDraft} cleaned={s.cleaned} changeCleaned={s.changeCleaned} hasPolished={s.rows.some(r => !!r.polished_text)} flush={s.flushDraft} remove={s.remove} />}
        {listening && <Button secondary label={t('cancel')} onPress={() => Alert.alert(t('cancelTitle'), undefined, [
          { text: t('backRecording'), style: 'cancel' }, { text: t('keep'), onPress: () => act(s.stop) }, { text: t('discard'), style: 'destructive', onPress: () => act(s.remove) }
        ])} />}

      </View>
      <BottomSheet visible={more} title={t('more')} close={() => setMore(false)}>
        {captionsAvailable(connection.status, connection.health, s.live.status) && <Button secondary label={t('captions')} onPress={() => { setMore(false); router.push('/captions'); }} />}
      </BottomSheet>
    </KeyboardAvoidingView>

  </SafeAreaView>;
}
