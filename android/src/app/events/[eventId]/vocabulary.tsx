import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { getEvent } from '@/lib/firebase/events';
import { authedClient } from '@/lib/server/authedClient';
import { VocabularyAPI, validateTerms } from '@/lib/server/vocabulary';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
export default function Vocabulary() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>(), uid = useAuthStore(s => s.user?.uid);
  return <VocabularyContent key={`${uid}:${eventId}`} uid={uid} eventId={eventId} />;
}
function VocabularyContent({ uid, eventId }: { uid?: string; eventId: string }) {
  const [edited,setEdited] = useState<string | null>(null), [message,setMessage] = useState(''), [busy,setBusy] = useState(false);
  const api = () => new VocabularyAPI(uid ? authedClient(uid) : null);
  const event = useQuery({ queryKey: ['event',uid,eventId], enabled: !!uid, queryFn: () => getEvent(eventId,uid!) });
  const terms = useQuery({ queryKey: ['vocabulary',uid,eventId], enabled: !!uid, retry: false, queryFn: () => api().load(eventId) });
  const value = edited ?? terms.data?.terms.join('\n') ?? '';
  return <Screen title="Vocabulary">
    <Banner message="Terms help Whisper spell names, places and jargon. Changes apply to chunks transcribed after saving. This screen needs the laptop." />
    {terms.isPending && <Banner message="Loading laptop vocabulary..." />}
    {terms.error && <><Banner error message="Laptop unavailable. Connect and reload vocabulary before editing." /><Button label="Reload" onPress={() => { void terms.refetch(); }} /></>}
    <TextField label="Terms (one per line)" multiline editable={!!terms.data && !busy} value={value} onChangeText={setEdited} />
    <Button secondary label="Add event speakers" disabled={!terms.data || !event.data || busy} onPress={() => setEdited([...new Set([...value.split('\n'),...event.data!.speakers])].filter(Boolean).join('\n'))} />
    {message && <Banner message={message} />}
    <Button label="Save vocabulary" loading={busy} disabled={!terms.data} onPress={() => {
      try {
        const values = validateTerms(value.split('\n')); setBusy(true); setMessage('');
        void api().save(eventId,values).then(async () => { setEdited(values.join('\n')); setMessage('Vocabulary saved. Applies to future transcription.'); await terms.refetch(); }).catch(() => setMessage('Could not save. Check the laptop connection and try again.')).finally(() => setBusy(false));
      } catch (e) { setMessage((e as Error).message); }
    }} />
  </Screen>;
}
