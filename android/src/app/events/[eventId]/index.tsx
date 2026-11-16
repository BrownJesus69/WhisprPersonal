import { useState, useEffect } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { createLocalSession } from '@/lib/session/recordingStore';
import { listNotes } from '@/lib/notes/notes';
import { onNotesChanged } from '@/lib/notes/noteSync';
import { repositories } from '@/lib/db/repositories';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvent } from '@/lib/firebase/events';
import { useAuthStore } from '@/state/authStore';
import { LANGUAGES } from '@/types/models';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { ButtonRow } from '@/components/ButtonRow';
import { Card } from '@/components/Card';
import { Collapsible } from '@/components/Collapsible';
import { KeyValueRow } from '@/components/KeyValueRow';
import { SectionHeader } from '@/components/SectionHeader';
import { useTheme, typography } from '@/theme';

const STATUS_TEXT: Record<string, string> = { recording: 'Recording', paused: 'Paused', stopped: 'Transcribing', interrupted: 'Interrupted', finalizing: 'Transcribing', finalized: 'Done', failed: 'Failed' };

export default function EventDetail() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const t = useTheme();
  const uid = useAuthStore(s => s.user?.uid);
  const client = useQueryClient();
  const notes = useQuery({ queryKey: ['notes',uid,eventId], enabled: !!uid, queryFn: () => listNotes(uid!,eventId) });
  useEffect(() => onNotesChanged(() => { void client.invalidateQueries({ queryKey: ['notes',uid,eventId] }); }), [client,uid,eventId]);
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const sessions = useQuery({ queryKey: ['local-sessions', uid, eventId], enabled: !!uid, refetchInterval: 3000,
    queryFn: async () => (await (await repositories()).sessions(uid!)).filter(s => s.event_id === eventId) });
  const { data: event, isPending, error } = useQuery({ queryKey: ['event', uid, eventId], enabled: !!uid, queryFn: () => getEvent(eventId, uid!) });
  const open = (pathname: '/events/[eventId]/notes' | '/events/[eventId]/brief' | '/events/[eventId]/export' | '/events/[eventId]/vocabulary') => router.push({ pathname, params: { eventId } });
  const noteCount = notes.data?.filter(n => !n.deleted).length ?? 0;
  const subtitle = event && [event.location, event.languageMode === 'auto' ? '' : LANGUAGES.find(l => l.code === event.languageMode)?.name].filter(Boolean).join(' · ');
  return <Screen title={event?.title ?? 'Event'}>
    {isPending && <Banner message="Loading event…" />}
    {error && <Banner error message="Could not load this event. Go back and open it again." />}
    {!isPending && !error && !event && <Banner message="Event not found" />}
    {event && <>
      {!!subtitle && <Text style={{ ...typography.body, color: t.muted }}>{subtitle}</Text>}
      <Button large label="Start recording" loading={starting} onPress={() => {
        setStarting(true); setStartError('');
        void createLocalSession(event).then(s => router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.id } })).catch(() => setStartError('Could not create a local session. Check phone storage and try again.')).finally(() => setStarting(false));
      }} />
      {startError && <Banner error message={startError} />}
      <ButtonRow>
        <Button secondary label={noteCount ? `Notes (${noteCount})` : 'Notes'} onPress={() => open('/events/[eventId]/notes')} />
        <Button secondary label="Brief" onPress={() => open('/events/[eventId]/brief')} />
        <Button secondary label="Export" onPress={() => open('/events/[eventId]/export')} />
      </ButtonRow>
      {!!sessions.data?.length && <SectionHeader title="Recordings" />}
      {sessions.error && <Banner error message="Could not load saved recordings." />}
      {sessions.data?.map(s => <Card key={s.id}>
        <Button secondary label={`${new Date(s.created_at).toLocaleString()} · ${s.consent_at ? STATUS_TEXT[s.status] ?? s.status : 'Not started'}`} onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: s.id } })} />
        <Button secondary label="View transcript" onPress={() => router.push({ pathname: '/transcript/[sessionId]', params: { sessionId: s.id } })} />
      </Card>)}
      <Collapsible title="More">
        <Button secondary label="Vocabulary" onPress={() => open('/events/[eventId]/vocabulary')} />
        <Card>
          {!!event.description && <KeyValueRow label="Description" value={event.description} />}
          {!!event.speakers.length && <KeyValueRow label="Speakers" value={event.speakers.join(', ')} />}
          {!!event.agenda && <KeyValueRow label="Agenda" value={event.agenda} />}
          {event.startTime && <KeyValueRow label="Starts" value={event.startTime.toDate().toLocaleString()} />}
          <KeyValueRow label="Language" value={LANGUAGES.find(l => l.code === event.languageMode)?.name ?? 'Auto'} />
          <KeyValueRow label="Privacy" value={event.privacyMode === 'cloud_ai' ? 'Cloud AI allowed' : 'Local only'} />
          <KeyValueRow label="Status" value={event.status} />
        </Card>
      </Collapsible>
    </>}
  </Screen>;
}
