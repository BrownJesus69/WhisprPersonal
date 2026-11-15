import { Text } from 'react-native';
import type { Note, RemoteNote } from '@/lib/notes/model';
import { typography, useTheme } from '@/theme';
import { Card } from './Card';
import { Button } from './Button';
import { SyncChip } from './SyncChip';
import { timestamp } from './TranscriptRow';

export function NoteRow({ note, edit, remove, keepMine, useCloud, retry }: {
  note: Note; edit: () => void; remove: () => void; keepMine: () => void; useCloud: () => void; retry: () => void;
}) {
  const t = useTheme();
  const remote: RemoteNote | null = note.remote_json ? JSON.parse(note.remote_json) : null;
  return <Card>
    <Text style={{ ...typography.label, color: t.muted }}>{note.timestamp_ms !== null ? `${timestamp(note.timestamp_ms)} · ` : ''}{note.speaker ? `${note.speaker} · ` : ''}{note.source === 'transcript' ? 'From transcript' : note.source === 'ai' ? 'AI-assisted' : 'Manual'}</Text>
    <Text selectable style={{ ...typography.body, color: t.text }}>{note.deleted ? 'Deleted on this phone' : note.text}</Text>
    <SyncChip state={note.sync_state} />
    {note.sync_state === 'conflict' && remote && <>
      <Text accessibilityRole="header" style={{ ...typography.heading, color: t.text }}>Changed on another device</Text>
      <Text selectable style={{ ...typography.body, color: t.text }}>On this phone: {note.deleted ? 'Deleted' : note.text}</Text>
      <Text selectable style={{ ...typography.body, color: t.text }}>In the cloud: {remote.deleted ? 'Deleted' : remote.text}</Text>
      <Button label="Keep mine" onPress={keepMine} />
      <Button label="Use cloud" secondary onPress={useCloud} />
    </>}
    {note.sync_state === 'failed' && <Button label="Retry cloud sync" onPress={retry} />}
    {!note.deleted && <><Button label="Edit note" secondary onPress={edit} /><Button label="Delete note" secondary onPress={remove} /></>}
  </Card>;
}
