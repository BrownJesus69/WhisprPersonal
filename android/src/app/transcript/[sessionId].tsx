import { getCachedEvent } from '@/lib/firebase/events';
import { TranslationControl } from '@/components/TranslationControl';
import { TranslationList } from '@/components/TranslationList';
import { useTranslation } from '@/hooks/useTranslation';
import { useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { repositories } from '@/lib/db/repositories';
import { transcriptParts, clock, languageName } from '@/lib/export/compose';
import { filterTranscript, sequenceIndex } from '@/lib/live/viewer';
import { createNote } from '@/lib/notes/notes';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { KeyValueRow } from '@/components/KeyValueRow';
import { TextField } from '@/components/TextField';
import { TranscriptTabs } from '@/components/TranscriptTabs';
import { TranscriptRow, type DisplayRow } from '@/components/TranscriptRow';
export default function TranscriptViewer() {
  const { sessionId, sequence } = useLocalSearchParams<{ sessionId: string; sequence?: string }>();
  const uid = useAuthStore(s => s.user?.uid);
  const [tab,setTab] = useState<'raw'|'polished'|'translation'>('raw'), [search,setSearch] = useState(''), [message,setMessage] = useState('');
  const list = useRef<FlatList<DisplayRow>>(null), jumped = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const query = useQuery({ queryKey: ['viewer',uid,sessionId], enabled: !!uid, queryFn: async () => {
    const repo = await repositories(), session = await repo.session(sessionId);
    if (!session || session.owner_uid !== uid) throw new Error('Unavailable');
    return { session, rows: await repo.transcript(sessionId), languages: await repo.languageEvents(sessionId) };
  } });
  const translation = useTranslation(query.data?.session);
  const event = useQuery({ queryKey: ['translation-event',uid,query.data?.session.event_id], enabled: !!query.data && !!uid, queryFn: () => getCachedEvent(query.data!.session.event_id,uid!) });
  const rows = query.data ? transcriptParts(query.data.session,query.data.rows,tab === 'polished' ? 'polished' : 'raw') : [];
  const filtered = filterTranscript(rows,search), index = sequenceIndex(filtered,sequence);
  const target = useRef(index);
  useEffect(() => { target.current = index; }, [index]);
  useEffect(() => { jumped.current = false; return () => { if (retry.current) clearTimeout(retry.current); }; }, [sessionId,sequence]);
  const jump = () => {
    if (jumped.current || target.current < 0) return;
    jumped.current = true;
    list.current?.scrollToIndex({ index: target.current, animated: false });
  };
  return <Screen title="Transcript" scroll={false}>
    {query.isPending && <Banner message="Loading local transcript..." />}
    {query.error && <Banner error message="Could not open this transcript on this account." />}
    {query.data && <>
      <KeyValueRow label="Session date" value={new Date(query.data.session.created_at).toLocaleString()} />
      <KeyValueRow label="Duration" value={clock(query.data.session.time_ms)} />
      <KeyValueRow label="Transcript status" value={query.data.session.finalize_status ?? query.data.session.status} />
      <KeyValueRow label="Language timeline" value={query.data.languages.map(e => e.language ? `${languageName(e.language)} (part ${(e.at_sequence ?? 0)+1})` : '').filter(Boolean).join(' \u2192 ') || [...new Set(rows.map(r => r.language).filter(Boolean))].map(l => languageName(l!)).join(' \u2192 ') || 'Unknown'} />
      <TranslationControl session={query.data.session} privacy={event.data?.privacyMode} target={translation.target} change={translation.setTarget} active={translation.active} job={translation.job} onSubmitted={() => setTab('translation')} />
      {translation.message && <Banner message={translation.message} />}
      <TranscriptTabs translation={query.data.session.status === 'finalized'} selected={tab} onSelect={setTab} />
      <TextField label="Search transcript" value={search} onChangeText={setSearch} />
      <KeyValueRow label="Matches" value={String(filtered.length)} />
      {message && <Banner message={message} />}
      {tab === 'translation' ? <TranslationList session={query.data.session} originals={query.data.rows} rows={translation.rows} target={translation.target} search={search} /> : <FlatList accessibilityLabel="Saved transcript rows" ref={list} data={filtered} keyExtractor={r => String(r.sequence)} onLayout={jump} onContentSizeChange={jump}
        onScrollToIndexFailed={info => { list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false }); jumped.current = false; if (retry.current) clearTimeout(retry.current); retry.current = setTimeout(jump,100); }}
        ListEmptyComponent={<Banner message="No matching transcript rows." />}
        renderItem={({ item }) => <TranscriptRow row={item} onAddNote={tab === 'raw' ? row => {
          void createNote(query.data!.session.event_id,{ text: row.text, source: 'transcript', timestampMs: row.startMs, sessionId, sequence: row.sequence, language: row.language ?? null }).then(() => setMessage('Added to notes')).catch(() => setMessage('Could not add this note. Try again.'));
        } : undefined} />} />}
    </>}
  </Screen>;
}
