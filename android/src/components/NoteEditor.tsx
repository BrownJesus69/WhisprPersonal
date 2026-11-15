import { useState } from 'react';
import { Modal } from 'react-native';
import { validateNoteInput } from '@/lib/notes/model';
import { Screen } from './Screen';
import { TextField } from './TextField';
import { ChipSelect } from './ChipSelect';
import { Button } from './Button';
import { Banner } from './Banner';

export function NoteEditor({ text: initial = '', speaker: initialSpeaker = null, speakers, save, cancel }: {
  text?: string; speaker?: string | null; speakers: string[];
  save: (input: { text: string; speaker: string | null }) => Promise<unknown>; cancel: () => void;
}) {
  const [text, setText] = useState(initial), [speaker, setSpeaker] = useState(initialSpeaker);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <Modal visible animationType="none" onRequestClose={cancel}>
    <Screen title={initial ? 'Edit note' : 'Add note'}>
      <TextField label="Note text" multiline value={text} onChangeText={setText} />
      <ChipSelect options={[{ value: '', label: 'None' }, ...[...new Set([...speakers, ...(initialSpeaker ? [initialSpeaker] : [])])].filter(s => s && s.length <= 100).map(s => ({ value: s, label: s }))]}
        selected={[speaker ?? '']} onSelect={s => setSpeaker(s || null)} />
      {!!error && <Banner error message={error} />}
      <Button label="Save note" loading={busy} onPress={() => {
        try { validateNoteInput({ text, speaker }); } catch (e) { setError((e as Error).message); return; }
        setBusy(true); setError('');
        void save({ text: text.trim(), speaker }).then(cancel).catch(() => setError('Could not save on this phone. Try again.')).finally(() => setBusy(false));
      }} />
      <Button label="Cancel" secondary disabled={busy} onPress={cancel} />
    </Screen>
  </Modal>;
}
