import { useState, useEffect } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { createLocalSession } from '@/lib/session/recordingStore';
import { listNotes } from '@/lib/notes/notes';
import { onNotesChanged } from '@/lib/notes/noteSync';
import { repositories } from '@/lib/db/repositories';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvent } from '@/lib/firebase/events';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { KeyValueRow } from '@/components/KeyValueRow';
import { StatusBadge } from '@/components/StatusBadge';

export default function EventDetail() {
  const { eventId } = useLocalSearchParams<{
    eventId: string;
  }>();
  const uid = useAuthStore(s => s.user?.uid);
  const client = useQueryClient();
  const count = useQuery({ queryKey: ['notes',uid,eventId], enabled: !!uid, queryFn: () => listNotes(uid!,eventId) });
  useEffect(() => onNotesChanged(() => { void client.invalidateQueries({ queryKey: ['notes',uid,eventId] }); }), [client,uid,eventId]);
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const sessions = useQuery({ queryKey: ['local-sessions', uid, eventId], enabled: !!uid, refetchInterval: 3000,
    queryFn: async () => (await (await repositories()).sessions(uid!)).filter(s => s.event_id === eventId) });
  const { data: event, isPending, error } = useQuery({ queryKey: ['event', uid, eventId], enabled: !!uid, queryFn: () => getEvent(eventId, uid!) });
  return <Screen title={event?.title ?? 'Event'}>
    {isPending && <Banner message="Loading event…" />}
    {error && <Banner error message="Could not load this event." />}
    {!isPending && !error && !event && <Banner message="Event not found" />}
    {event && <>
      <Button label={`Notes (${count.data?.filter(n => !n.deleted).length ?? 0})`} onPress={() => router.push({ pathname: '/events/[eventId]/notes', params: { eventId } })} />
      <Button label="Briefs" onPress={() => router.push({ pathname: '/events/[eventId]/brief', params: { eventId } })} />
      <StatusBadge status={event.status} />
      <Card>
        <KeyValueRow label="Description" value={event.description || '—'} />
        <KeyValueRow label="Location" value={event.location || '—'} />
        <KeyValueRow label="Starts" value={event.startTime?.toDate().toLocaleString()} />
        <KeyValueRow label="Ends" value={event.endTime?.toDate().toLocaleString()} />
        <KeyValueRow label="Agenda" value={event.agenda || '—'} />
        <KeyValueRow label="Speakers" value={event.speakers.join(', ') || '—'} />
        <KeyValueRow label="Languages" value={event.languages.join(', ') || 'Auto'} />
        <KeyValueRow label="Language mode" value={event.languageMode} />
        <KeyValueRow label="Privacy" value={event.privacyMode} />
      </Card>
      <Button label="Start session" loading={starting} onPress={() => {
        setStarting(true); setStartError('');
        void createLocalSession(event).then(s => router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.id } })).catch(() => setStartError('Could not create a local session. Check phone storage and try again.')).finally(() => setStarting(false));
      }} />
      {startError && <Banner error message={startError} />}
      {sessions.error && <Banner error message="Could not load saved sessions." />}
      {sessions.data?.map(s => <Button key={s.id} secondary label={`${new Date(s.created_at).toLocaleString()} · ${s.consent_at ? s.status : 'ready'}`} onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.id } })} />)}
    </>}
  </Screen>;
}
