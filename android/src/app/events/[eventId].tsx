import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
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
  const { data: event, isPending, error } = useQuery({ queryKey: ['event', uid, eventId], enabled: !!uid, queryFn: () => getEvent(eventId, uid!) });
  return <Screen title={event?.title ?? 'Event'}>
    {isPending && <Banner message="Loading event…" />}
    {error && <Banner error message="Could not load this event." />}
    {!isPending && !error && !event && <Banner message="Event not found" />}
    {event && <>
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
      <Button disabled label="Start session" onPress={() => {
      }} />
      <Banner message="Recording arrives in the next update" />
      <Banner message="Recording consent preview: before recording, tell everyone that audio will be sent to your own laptop and transcripts and notes will sync to Firebase. Obtain permission from all participants. Cloud AI is optional. No recording has started." />
    </>}
  </Screen>;
}
