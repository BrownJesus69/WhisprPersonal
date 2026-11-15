import { useState } from 'react';
import { createNote } from '@/lib/notes/notes';
import { validateNoteInput, type NoteInput } from '@/lib/notes/model';
import { TextField } from './TextField';
import { Button } from './Button';
import { Banner } from './Banner';

export function quickNoteInput(text: string, sessionId: string, phase: string, elapsedMs: number): NoteInput {
  return { text, sessionId, timestampMs: ['recording','paused'].includes(phase) ? Math.max(0, Math.floor(elapsedMs)) : null };
}
export function QuickNote({ eventId, sessionId, phase, elapsedMs, save = createNote }: {
  eventId: string; sessionId: string; phase: string; elapsedMs: number;
  save?: (eventId: string, input: NoteInput) => Promise<unknown>;
}) {
  const [text, setText] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  return <>
    <TextField label="Quick note" value={text} onChangeText={setText} multiline />
    <Button label="Add note" loading={busy} onPress={() => {
      const input = quickNoteInput(text,sessionId,phase,elapsedMs);
      try { validateNoteInput(input); } catch (e) { setError(true); setMessage((e as Error).message); return; }
      setBusy(true);
      void save(eventId,input).then(() => { setText(''); setError(false); setMessage('Saved on phone'); })
        .catch(() => { setError(true); setMessage('Could not save on this phone. Try again.'); }).finally(() => setBusy(false));
    }} />
    {!!message && <Banner error={error} message={message} />}
  </>;
}
