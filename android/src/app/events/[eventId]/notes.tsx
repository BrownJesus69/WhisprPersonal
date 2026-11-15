import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/state/authStore';
import { getEvent } from '@/lib/firebase/events';
import { createNote, editNote, deleteNote, keepMine, useCloud as chooseCloud, retryFailed, listNotes, noteStates } from '@/lib/notes/notes';
import { useRecordingStore } from '@/lib/session/recordingStore';
import { repositories } from '@/lib/db/repositories';
import { noteSync, onNotesChanged } from '@/lib/notes/noteSync';
import type { Note } from '@/lib/notes/model';
import { Screen } from '@/components/Screen';
import { TextField } from '@/components/TextField';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { NoteRow } from '@/components/NoteRow';
import { NoteEditor } from '@/components/NoteEditor';

export default function EventNotes() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const uid = useAuthStore(s => s.user?.uid), client = useQueryClient();
  const [search, setSearch] = useState(''), [editor, setEditor] = useState<Note | 'new' | null>(null), [error, setError] = useState('');
  const key = ['notes',uid,eventId];
  useEffect(() => noteSync.watch(eventId), [eventId,uid]);
  useEffect(() => onNotesChanged(() => { void client.invalidateQueries({ queryKey: ['notes',uid,eventId] }); }), [client,uid,eventId]);
  const notes = useQuery({ queryKey: key, enabled: !!uid, queryFn: () => listNotes(uid!,eventId) });
  const states = useQuery({ queryKey: [...key,'states'], enabled: !!uid, queryFn: () => noteStates(uid!,eventId) });
  const filtered = useQuery({ queryKey: [...key,'list',search], enabled: !!uid, queryFn: () => listNotes(uid!,eventId,search) });
  const event = useQuery({ queryKey: ['event',uid,eventId], enabled: !!uid, queryFn: () => getEvent(eventId,uid!) });
  const all = states.data ?? [], conflicts = all.filter(s => s === 'conflict').length;
  const pending = all.filter(s => s === 'pending').length, failed = all.filter(s => s === 'failed').length;
  const act = (action: () => Promise<unknown>) => { void action().catch(() => setError('Could not update this note on the phone. Try again.')); };
  return <Screen title="Notes">
    <Banner message={conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'} needs you` : failed ? `${failed} notes not saved to cloud` : pending ? `${pending} notes waiting to sync` : 'All notes synced'} />
    {(notes.error || filtered.error || error) && <Banner error message={error || 'Could not load notes on this phone.'} />}
    <TextField label="Search notes" value={search} onChangeText={setSearch} />
    <Button label="Add note" onPress={() => setEditor('new')} />
    <Button label="AI-assisted notes · not configured" disabled onPress={() => {}} />
    {!filtered.isPending && !filtered.data?.length && <EmptyState message={search ? 'No matching notes' : 'Take your first note'} />}
    {filtered.data?.map(n => <NoteRow key={n.id} note={n} edit={() => setEditor(n)} remove={() => Alert.alert('Delete note?', 'The deletion will sync to your other devices.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => act(() => deleteNote(n.id)) }])}
      keepMine={() => act(() => keepMine(n.id))} useCloud={() => act(() => chooseCloud(n.id))} retry={() => act(() => retryFailed(n.id))} />)}
    {editor && <NoteEditor key={typeof editor === 'string' ? editor : editor.id} text={typeof editor === 'string' ? '' : editor.text} speaker={typeof editor === 'string' ? null : editor.speaker} speakers={event.data?.speakers ?? []}
      cancel={() => setEditor(null)} save={async input => {
        if (editor !== 'new') return editNote(editor.id,input);
        const recording = useRecordingStore.getState();
        const session = recording.sessionId ? await (await repositories()).session(recording.sessionId) : null;
        const during = session?.owner_uid === uid && session?.event_id === eventId && ['recording','paused'].includes(recording.phase);
        return createNote(eventId,{ ...input, sessionId: during ? session!.id : null, timestampMs: during ? Math.floor(recording.elapsedMs) : null });
      }} />}
  </Screen>;
}
