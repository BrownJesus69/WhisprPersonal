import { useAuthStore } from '@/state/authStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen } from './Screen';
import { Button } from './Button';
import { ButtonRow } from './ButtonRow';
import { Banner } from './Banner';
import { TextField } from './TextField';
import { EmptyState } from './EmptyState';
import { ConnectionPill } from './ConnectionPill';
import { useMyEvents } from '@/hooks/useMyEvents';
import { useConnectionStore } from '@/state/connectionStore';
import { useTheme, typography, spacing } from '@/theme';
import type { EventModel } from '@/types/models';

const STATUS_TEXT: Record<EventModel['status'], string> = { draft: 'New', active: 'Recording', processing: 'Transcribing', completed: 'Done', failed: 'Needs attention' };

function EventRow({ event }: { event: EventModel }) {
  const t = useTheme();
  const when = (event.startTime ?? event.createdAt)?.toDate().toLocaleDateString();
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={event.title}
    onPress={() => router.push({ pathname: '/events/[eventId]', params: { eventId: event.id } })}
    style={({ pressed }) => ({ padding: spacing.md, gap: spacing.xs, borderRadius: 20, backgroundColor: t.surface, opacity: pressed ? 0.72 : 1 })}
  >
    <Text style={{ ...typography.heading, color: t.text }} numberOfLines={2}>{event.title}</Text>
    <Text style={{ ...typography.body, color: t.muted }}>{[STATUS_TEXT[event.status], when, event.location].filter(Boolean).join(' · ')}</Text>
  </Pressable>;
}

export function EventList() {
  const { events, loading, error, fromCache } = useMyEvents();
  const connected = useConnectionStore(s => ['connected', 'verified'].includes(s.status));
  const [search, setSearch] = useState('');
  const uid = useAuthStore(s => s.user?.uid);
  const hiddenId = useSettingsStore(s => uid ? s.speakEventIds[uid] || (s.speakEventOwner === uid ? s.speakEventId : '') : '');
  const filtered = events.filter(e => e.id !== hiddenId).filter(e => `${e.title} ${e.location}`.toLowerCase().includes(search.toLowerCase()));
  return <Screen title="Events">
    {!connected && <ConnectionPill />}
    <ButtonRow>
      <Button label="New event" onPress={() => router.push('/events/new')} />
      <Button secondary label="Search notes" onPress={() => router.push('/search')} />
    </ButtonRow>
    {events.length > 5 && <TextField label="Filter events" value={search} onChangeText={setSearch} />}
    {fromCache && <Banner message="Offline · showing events saved on this phone" />}
    {loading && <Banner message="Loading your events…" />}
    {error && <Banner error message="Events could not be loaded. Check your internet connection." />}
    {!loading && !error && !filtered.length && <EmptyState message={search ? 'No matching events' : 'No events yet. Create one to start recording.'} />}
    {filtered.map(e => <EventRow key={e.id} event={e} />)}
  </Screen>;
}
