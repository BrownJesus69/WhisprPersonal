import { useCallback, useRef, useState, type ComponentRef } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useSpeak } from '@/features/speak/useSpeak';
import { followsLatest } from '@/features/speak/captions';
import { useSettingsStore } from '@/state/settingsStore';
import { Button } from '@/components/Button';
import { MicButton } from '@/components/ui/MicButton';
import { LanguageChip } from '@/components/ui/LanguageChip';
import { StatusLabel } from '@/components/ui/StatusLabel';
import { ComputerNotice } from '@/components/ui/ComputerNotice';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { RecognitionNotice } from '@/components/ui/RecognitionNotice';
import { fontFor, lineHeightFor } from '@/theme/fonts';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

// Mount the hook only while listening; unmounting releases this screen's awake tag.
export function ListeningAwake() { useKeepAwake('live-captions'); return null; }
export default function Captions() {
  const s = useSpeak(), c = useTheme(), size = useSettingsStore(state => state.captionSize);
  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  const [following, setFollowing] = useState(true), [error, setError] = useState('');
  const follow = useRef(true), scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const listening = s.state === 'listening';
  const processing = ['starting','stopping','processing','slow'].includes(s.state);
  const act = (action: () => Promise<unknown>) => { setError(''); void action().catch(() => setError(t('failed'))); };
  const latest = () => { follow.current = true; setFollowing(true); scroll.current?.scrollToEnd({ animated: false }); };
  const finals = [...s.live.model.finals.values(), ...s.rows.filter(row => !s.live.model.finals.has(row.sequence))].sort((a,b) => a.sequence - b.sequence);
  return <SafeAreaView style={{ flex: 1, backgroundColor: c.background, paddingHorizontal: 20, gap: 12 }}>
    {focused && listening && s.recording.phase === 'recording' && <ListeningAwake />}
    <Text accessibilityRole="header" style={{ ...typography.heading, color: c.text }}>{t('captions')}</Text>
    <StatusLabel live={s.live.status} />
    <LanguageChip />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      <Button secondary label={t('captionMinus')} accessibilityLabel={t('captionSmaller')} disabled={size <= 20} onPress={() => useSettingsStore.getState().set({ captionSize: size - 2 })} />
      <Button secondary label={t('captionPlus')} accessibilityLabel={t('captionLarger')} disabled={size >= 40} onPress={() => useSettingsStore.getState().set({ captionSize: size + 2 })} />
    </View>
    <ScrollView testID="captions-scroll" ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ gap: 16, paddingVertical: 12 }} scrollEventThrottle={100}
      onScroll={event => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        follow.current = followsLatest(contentOffset.y, contentSize.height, layoutMeasurement.height);
        setFollowing(follow.current);
      }} onContentSizeChange={() => { if (follow.current) scroll.current?.scrollToEnd({ animated: false }); }}>
      {finals.filter(row => !row.no_speech).map(row => <Text key={row.sequence} selectable style={{ fontSize: size, lineHeight: lineHeightFor(row.raw_text, size), fontFamily: fontFor(row.raw_text), color: c.text }}>{row.raw_text}</Text>)}
      {[...s.live.model.partials].filter(([sequence]) => !finals.some(row => row.sequence === sequence)).map(([sequence, segments]) => {
        const text = segments.map(segment => segment.text).join(' ');
        return <Text key={sequence} style={{ fontSize: size, lineHeight: lineHeightFor(text, size), fontFamily: fontFor(text), color: c.muted, fontStyle: 'italic' }}>{text}</Text>;
      })}
      <ComputerNotice recorded={!!s.session?.consent_at && !!s.session.master_uri} live={s.live.status} errorCode={s.session?.last_error} />
      <RecognitionNotice session={s.session} rows={s.rows} again={() => act(s.start)} />
      {s.state === 'slow' && <InlineNotice title={t('slow')} safety={t('safe')} action={t('retry')} onPress={() => act(s.finish)} />}
      {(error || ['failed','permission_denied','microphone_unavailable'].includes(s.state)) && <InlineNotice title={error || t(s.state === 'permission_denied' ? 'permission' : s.state === 'microphone_unavailable' ? 'micBusy' : 'failed')} safety={s.session?.consent_at ? t('uncertain') : t('nothingRecorded')} action={t(s.state === 'permission_denied' ? 'openSettings' : 'retry')} onPress={() => act(s.state === 'permission_denied' ? Linking.openSettings : s.retry)} />}
    </ScrollView>
    {!following && <Button secondary label={t('jumpLatest')} onPress={latest} />}
    <View testID="captions-dock" style={{ paddingVertical: 12 }}>
      <MicButton state={listening ? 'listening' : processing ? 'processing' : s.state === 'complete' ? 'complete' : 'ready'} elapsed={t('listening', { time: Math.floor(s.recording.elapsedMs / 1000) })} onPress={() => act(listening ? s.stop : s.start)} />
    </View>
  </SafeAreaView>;
}
