import { useState } from 'react';
import { router } from 'expo-router';
import { Screen } from './Screen';
import { Button } from './Button';
import { Banner } from './Banner';
import { Card } from './Card';
import { TextField } from './TextField';
import { KeyValueRow } from './KeyValueRow';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';
import { ConnectionPill } from './ConnectionPill';
import { useMyEvents } from '@/hooks/useMyEvents';

export function EventList({ past = false }: {
  past?: boolean;
}) {
  const { events, loading, error, fromCache } = useMyEvents();
  const [search, setSearch] = useState('');
  const filtered = events.filter(e => (!past || ['completed', 'failed'].includes(e.status)) && `${e.title} ${e.location}`.toLowerCase().includes(search.toLowerCase()));
  return <Screen title={past ? 'Your library' : 'Your events'}>
    {past ? <Banner message="Past events are read-only. Library tools arrive in Phase 9." /> : <>
      <ConnectionPill />
      <Button label="Create event" onPress={() => router.push('/events/new')} />
    </>}
    <TextField label="Search title or location" value={search} onChangeText={setSearch} />
    {fromCache && <Banner message="Offline · showing events saved on this device" />}
    {loading && <Banner message="Loading your events…" />}
    {error && <Banner error message="Events could not be loaded. Check your connection and Firebase rules." />}
    {!loading && !error && !filtered.length && <EmptyState message={search ? 'No matching events' : past ? 'No past events yet' : 'Your next event starts here.'} label={!past ? 'Create event' : undefined} onPress={() => router.push('/events/new')} />}
    {filtered.map(e => <Card key={e.id}>
      <StatusBadge status={e.status} />
      <KeyValueRow label={e.title} value={e.location || 'Location not set'} />
      <Button secondary label={e.status === 'active' && !past ? 'Resume' : `View ${e.title}`} onPress={() => router.push({ pathname: '/events/[eventId]', params: { eventId: e.id } })} />
    </Card>)}
  </Screen>;
}
