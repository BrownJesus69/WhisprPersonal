import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { ensureSpeakEvent } from '@/features/speak/speakEvent';
import { VocabularyAPI, validateTerms } from '@/lib/server/vocabulary';
import { authedClient } from '@/lib/server/authedClient';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

export default function PersonalWords() {
  const uid = useAuthStore(s => s.user?.uid);
  return <PersonalWordsContent key={uid} uid={uid} />;
}
function PersonalWordsContent({ uid }: { uid?: string }) {
  const connected = useConnectionStore(s => ['connected', 'verified'].includes(s.status));
  const [edited, setEdited] = useState<string[] | null>(null), [word, setWord] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<'validation' | 'save' | null>(null), [saved, setSaved] = useState(false);
  const c = useTheme();
  const api = () => new VocabularyAPI(uid ? authedClient(uid) : null);
  const query = useQuery({ queryKey: ['personal-words', uid], enabled: !!uid && connected, retry: false, queryFn: async () => {
    const event = await ensureSpeakEvent(uid!);
    return { eventId: event.id, ...await api().load(event.id) };
  } });
  const words = edited ?? query.data?.terms ?? [];
  const update = (values: string[]) => { setEdited(validateTerms(values)); setSaved(false); setError(null); };
  return <Screen title={t('personalWords')}>
    <Text style={{ ...typography.body, color: c.text }}>{t('personalWordsHelp')}</Text>
    <Text style={{ ...typography.caption, color: c.muted }}>{t('personalWordsPromise')}</Text>
    {!connected ? <InlineNotice title={t('personalWordsOffline')} safety={t('connectionSafety')} action={t('connect')} onPress={() => router.push('/connect')} /> : <>
      {query.isPending && <Text style={{ ...typography.body, color: c.muted }}>{t('loadingWords')}</Text>}
      {query.error && <InlineNotice title={t('wordsLoadFailed')} safety={t('wordsSafe')} action={t('retry')} onPress={() => { void query.refetch(); }} />}
      <TextField label={t('addWord')} value={word} editable={!!query.data && !busy} onChangeText={setWord} />
      <Button secondary label={t('add')} disabled={!word.trim() || !query.data || busy} onPress={() => { try { update([...words, word]); setWord(''); } catch { setError('validation'); } }} />
      {words.map(value => <View key={value} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, borderColor: c.border }}>
        <Text style={{ ...typography.body, flex: 1, color: c.text }}>{value}</Text><Button secondary label={t('remove')} disabled={busy} onPress={() => update(words.filter(w => w !== value))} />
      </View>)}
      {error && <InlineNotice title={t(error === 'validation' ? 'wordsLimit' : 'wordsFailed')} safety={t('wordsSafe')} action={t('retry')} onPress={() => setError(null)} />}
      {saved && <Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: c.muted }}>{t('wordsSaved')}</Text>}
      <Button label={t('save')} disabled={!query.data} loading={busy} onPress={() => {
        if (!query.data) return;
        setBusy(true); setError(null); setSaved(false);
        void api().save(query.data.eventId, validateTerms(words)).then(() => setSaved(true)).catch(() => setError('save')).finally(() => setBusy(false));
      }} />
    </>}
  </Screen>;
}
