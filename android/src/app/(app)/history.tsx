import { useSettingsStore } from '@/state/settingsStore';
import { useMyEvents } from '@/hooks/useMyEvents';
import { speakEventId } from '@/features/speak/speakEvent';
import { getEvent } from '@/lib/firebase/events';
import { kv } from '@/lib/storage/kv';
import { draftKey } from '@/features/speak/drafts';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { repositories } from '@/lib/db/repositories';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { historyGroup, duration } from '@/features/speak/history';
import { useTheme, typography } from '@/theme';
import { fontFor } from '@/theme/fonts';
import { t } from '@/i18n';
export default function History() {
  const uid = useAuthStore(s => s.user?.uid), c = useTheme();
  const [search, setSearch] = useState(''), [copied, setCopied] = useState(''), [copyError, setCopyError] = useState(false);
  const query = useQuery({ queryKey: ['speak-history', uid], enabled: !!uid, refetchInterval: 1500, queryFn: async () => {
    const repo = await repositories();
    return Promise.all((await repo.sessions(uid!)).sort((a,b) => b.created_at.localeCompare(a.created_at)).map(async session => ({ session, text: await kv.getItem(draftKey(uid!, session.id)) ?? (await repo.transcript(session.id)).sort((a,b) => a.sequence - b.sequence).map(r => r.raw_text).join(' ') })));
  } });
  const rows = query.data ?? [];
  const keep = useSettingsStore(s => s.keepTranscripts);
  const { events } = useMyEvents();
  const speakId = uid ? speakEventId(uid) : '';
  const missingTitles = [...new Set(rows.map(r => r.session.event_id))].filter(id => id !== speakId && !events.some(e => e.id === id));
  const titles = useQuery({ queryKey: ['history-event-titles', uid, missingTitles], enabled: !!uid && missingTitles.length > 0, retry: false, staleTime: 300000, queryFn: async () => Object.fromEntries(await Promise.all(missingTitles.map(async id => {
    const event = await getEvent(id, uid!).catch(() => null);
    return [id, event?.title ?? t('unknownEvent')];
  }))) });
  return <Screen title={t('history')}>
    <TextInput accessibilityLabel={t('searchHistory')} placeholder={t('searchHistory')} placeholderTextColor={c.muted} value={search} onChangeText={setSearch} style={{ ...typography.body, color: c.text, minHeight: 48, padding: 12, backgroundColor: c.surface, borderRadius: 12 }} />
    {(query.error || copyError) && <InlineNotice title={t('failed')} safety={t('safe')} action={t('retry')} onPress={() => { setCopyError(false); void query.refetch(); }} />}
    {!keep && <Text style={{ ...typography.body, color: c.muted }}>{t('retentionHelp')}</Text>}
    {!rows.length && !query.isPending && <><Text style={{ ...typography.body, color: c.muted }}>{t('emptyHistory')}</Text><Button label={t('start')} onPress={() => router.push('/')} /></>}
    {(['today','yesterday','earlier'] as const).map(group => {
      const matching = rows.filter(r => historyGroup(r.session.created_at) === group && r.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
      return matching.length > 0 && <View key={group} style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={{ ...typography.heading, color: c.text }}>{t(group)}</Text>
        {matching.map(({ session, text }) => <View key={session.id} style={{ padding: 16, borderRadius: 16, backgroundColor: c.surface }}>
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/history/[sessionId]', params: { sessionId: session.id } })} style={{ minHeight: 48, gap: 8 }}>
            <Text numberOfLines={2} style={{ ...typography.body, lineHeight: 26, color: c.text, fontFamily: fontFor(text) }}>{text || t(session.finalize_status === 'interrupted' || session.status === 'interrupted' ? 'interruptedPreview' : ['stopped','finalizing'].includes(session.status) ? 'processing' : 'noText')}</Text>
            {session.event_id !== speakId && <Text style={{ ...typography.caption, color: c.muted }}>{t('eventTitle', { title: events.find(e => e.id === session.event_id)?.title || titles.data?.[session.event_id] || t('unknownEvent') })}</Text>}
            <Text style={{ ...typography.caption, lineHeight: 20, fontFamily: fontFor(t(session.language_mode)), color: c.muted }}>{t('metadata', { time: new Date(session.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), language: t(session.language_mode), duration: duration(session) })}</Text>
          </Pressable>
          {!!text && <Button secondary label={t('copy')} onPress={() => { void Clipboard.setStringAsync(text).then(() => setCopied(session.id)).catch(() => setCopyError(true)); }} />}
          {copied === session.id && <Text accessibilityLiveRegion="polite" style={{ color: c.muted }}>{t('copied')}</Text>}
        </View>)}
      </View>;
    })}
    <Button secondary label={t('eventsLink')} onPress={() => router.push('/events')} />
  </Screen>;
}
