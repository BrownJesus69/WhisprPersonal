import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { searchAll } from '@/lib/notes/notes';
import { noteSync, onNotesChanged } from '@/lib/notes/noteSync';
import { repositories } from '@/lib/db/repositories';
import { subscribeMyEvents } from '@/lib/firebase/events';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { SectionHeader } from '@/components/SectionHeader';

export default function Search() {
  const uid = useAuthStore(s => s.user?.uid), client = useQueryClient();
  const [text, setText] = useState(''), [query, setQuery] = useState('');
  useEffect(() => { const timer = setTimeout(() => setQuery(text.trim()),250); return () => clearTimeout(timer); }, [text]);
  useEffect(() => onNotesChanged(() => { void client.invalidateQueries({ queryKey: ['search',uid] }); }), [client,uid]);
  useEffect(() => {
    if (!uid) return;
    let disposed = false;
    const watches = new Map<string, () => void>();
    const watch = (id: string) => { if (!disposed && !watches.has(id)) watches.set(id,noteSync.watch(id)); };
    const scan = () => {
      void repositories().then(async repo => {
        const [sessions, eventIds] = await Promise.all([repo.sessions(uid),repo.noteEventIds(uid)]);
        for (const id of [...sessions.map(s => s.event_id),...eventIds]) watch(id);
      }).catch(() => {});
    };
    scan();
    const changes = onNotesChanged(scan);
    const release = subscribeMyEvents(uid, events => events.forEach(e => watch(e.id)), () => {});
    return () => { disposed = true; release(); changes(); for (const stop of watches.values()) stop(); };
  }, [uid]);
  const results = useQuery({ queryKey: ['search',uid,query], enabled: !!uid && query.length >= 2, queryFn: () => searchAll(uid!,query) });
  return <Screen title="Search">
    <TextField label="Search notes and transcripts" value={text} onChangeText={setText} />
    {query.length < 2 && <Banner message="Enter at least 2 characters" />}
    {results.error && <Banner error message="Could not search this phone. Try again." />}
    {query.length >= 2 && <>
      <SectionHeader title="Notes" />
      {results.data?.notes.map(n => <Button key={n.id} secondary label={n.text} onPress={() => router.push({ pathname: '/events/[eventId]/notes', params: { eventId: n.event_id } })} />)}
      {results.data && !results.data.notes.length && <Banner message="No matching notes" />}
      <SectionHeader title="Transcripts" />
      {results.data?.transcripts.map(r => <Button key={`${r.session_id}:${r.sequence}`} secondary label={r.raw_text} onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: r.session_id } })} />)}
      {results.data && !results.data.transcripts.length && <Banner message="No matching transcripts" />}
    </>}
  </Screen>;
}
