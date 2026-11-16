import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Share, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type { LocalSession } from '@/lib/db/repositories';
import { removePhoneAudio } from '@/features/speak/retention';
import { Button } from '@/components/Button';
import { BottomSheet } from './BottomSheet';
import { InlineNotice } from './InlineNotice';
import { useTheme, typography } from '@/theme';
import { fontFor, lineHeightFor } from '@/theme/fonts';
import { withDeadline } from '@/lib/deadline';
import { t } from '@/i18n';

export function TranscriptResult({ session, text, edit, cleaned, changeCleaned, hasPolished, flush, remove, hideEditor = false }: {
  hideEditor?: boolean;
  session: LocalSession; text: string; edit: (value: string) => void; cleaned: boolean;
  changeCleaned: (value: boolean) => Promise<void>; hasPolished: boolean; flush: () => Promise<void>;
  remove: () => Promise<unknown>;
}) {
  const c = useTheme();
  const [sheet, setSheet] = useState<'more' | 'delete' | null>(null), [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<'draft' | 'delete' | 'action' | 'share' | null>(null), [busy, setBusy] = useState(false), [audioDeleted, setAudioDeleted] = useState(false);
  const retry = useRef<() => void>(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const act = async (action: () => Promise<unknown>, kind: 'delete' | 'action' | 'share' = 'action', requireSaved = true) => {
    setBusy(true); setError(null); retry.current = () => { void act(action, kind, requireSaved); };
    try {
      try { await withDeadline(flush()); } catch { setError('draft'); if (requireSaved) return; }
      try { await withDeadline(action()); } catch { setError(kind); }
    } finally { setBusy(false); }
  };
  const confirm = (audio: boolean) => Alert.alert(t(audio ? 'deleteAudioTitle' : 'deleteTitle'), t(audio ? 'deleteAudioBody' : 'deleteTextBody'), [
    { text: t('cancel'), style: 'cancel' }, { text: t(audio ? 'deleteAudio' : 'deleteText'), style: 'destructive', onPress: () => { void act(async () => {
      if (audio) { await removePhoneAudio(session.owner_uid, session.id); setAudioDeleted(true); }
      else await remove();
      setSheet(null);
    }, 'delete'); } }
  ]);
  return <View style={{ gap: 12 }}>
    {!hideEditor && <TextInput multiline accessibilityLabel={t('transcript')} value={text} editable={!busy} onChangeText={edit} textAlignVertical="top" style={{ ...typography.transcript, minHeight: 160, color: c.text, fontFamily: fontFor(text), lineHeight: lineHeightFor(text, 19) }} />}
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
      <View style={{ flexGrow: 1 }}><Button label={t('copy')} disabled={busy} onPress={() => { void act(async () => {
        await Clipboard.setStringAsync(text); setCopied(text); AccessibilityInfo.announceForAccessibility(t('copied'));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 2000);
      }, 'action', false); }} /></View>
      <Button secondary label={t('share')} disabled={busy} onPress={() => { void act(() => Share.share({ message: text }), 'share', false); }} />
      <Button secondary label={t('more')} disabled={busy} onPress={() => setSheet('more')} />
    </View>
    {copied === text && <Text style={{ ...typography.caption, color: c.muted }}>{t('copied')}</Text>}
    {audioDeleted && <Text accessibilityLiveRegion="polite" style={{ ...typography.caption, color: c.muted }}>{t('audioDeleted')}</Text>}
    {error && <InlineNotice title={t(error === 'draft' ? 'draftFailed' : error === 'delete' ? 'deletionFailed' : error === 'share' ? 'shareFailed' : 'failed')} safety={t(error === 'draft' ? 'draftUnsafe' : error === 'delete' ? 'deletionSafe' : 'textUnchanged')} action={t(error === 'delete' ? 'connect' : 'retry')} onPress={() => { if (error === 'delete') router.push('/connect'); else if (error === 'draft') void act(flush); else retry.current(); }} />}
    <BottomSheet visible={sheet === 'more'} title={t('more')} close={() => setSheet(null)}>
      {hasPolished && <><Text style={{ ...typography.body, color: c.muted }}>{t('cleanupHelp')}</Text><Button secondary label={t('original')} selected={!cleaned} disabled={busy} onPress={() => { void act(() => changeCleaned(false)); }} /><Button secondary label={t('cleaned')} selected={cleaned} disabled={busy} onPress={() => { void act(() => changeCleaned(true)); }} /></>}
      <Button secondary label={t('timestamps')} disabled={busy} onPress={() => { void act(async () => { setSheet(null); router.push({ pathname: '/transcript/[sessionId]', params: { sessionId: session.id } }); }); }} />
      <Button secondary label={t('delete')} disabled={busy} onPress={() => setSheet('delete')} />
    </BottomSheet>
    <BottomSheet visible={sheet === 'delete'} title={t('delete')} close={() => setSheet(null)}>
      <Text style={{ ...typography.body, color: c.text }}>{t('deleteAudioBody')}</Text>
      <Button secondary label={t('deleteAudio')} disabled={session.status !== 'finalized' || busy} onPress={() => confirm(true)} />
      {session.status !== 'finalized' && <Text style={{ ...typography.caption, color: c.muted }}>{t('audioNotReady')}</Text>}
      <Text style={{ ...typography.body, color: c.text }}>{t('deleteTextBody')}</Text>
      <Button secondary label={t('deleteText')} disabled={busy} onPress={() => confirm(false)} />
    </BottomSheet>
  </View>;
}
