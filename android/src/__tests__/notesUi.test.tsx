import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { NoteRow } from '../components/NoteRow';
import { NoteEditor } from '../components/NoteEditor';
import { QuickNote, quickNoteInput } from '../components/QuickNote';
import { TranscriptRow } from '../components/TranscriptRow';
import { note, remote } from './noteFixtures';

test.each(['pending','synced','conflict','failed'] as const)('note row displays %s sync chip', async sync_state => {
  const view = await render(<NoteRow note={note({ sync_state, remote_json: sync_state === 'conflict' ? JSON.stringify(remote()) : null, timestamp_ms: 61000, source: 'transcript', speaker: 'Speaker' })} edit={jest.fn()} remove={jest.fn()} keepMine={jest.fn()} useCloud={jest.fn()} retry={jest.fn()} />);
  const labels = { pending: 'Saved on phone · syncing', synced: 'Synced', conflict: 'Conflict', failed: 'Not saved to cloud' };
  expect(view.getByLabelText(labels[sync_state])).toBeTruthy(); expect(view.getByText('01:01 · Speaker · From transcript')).toBeTruthy();
  if (sync_state === 'conflict') { expect(view.getByText('In the cloud: Cloud note')).toBeTruthy(); expect(view.getByLabelText('Keep mine')).toBeTruthy(); }
});
test('editor validates inline and saves trimmed local text with speaker', async () => {
  const save = jest.fn(async () => {}), cancel = jest.fn();
  const view = await render(<NoteEditor speakers={['Speaker']} save={save} cancel={cancel} />);
  await fireEvent.press(view.getByLabelText('Save note')); expect(save).not.toHaveBeenCalled(); expect(view.getByText('Enter a note of 1–5000 characters')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('Note text'),'  typed note  ');
  await fireEvent.press(view.getByLabelText('Speaker')); await fireEvent.press(view.getByLabelText('Save note'));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ text: 'typed note', speaker: 'Speaker' })); expect(cancel).toHaveBeenCalled();
});
test.each(['recording','paused','stopped','finalized'])('quick note stamps recording time for %s', phase => {
  expect(quickNoteInput('note','session',phase,12345).timestampMs).toBe(['recording','paused'].includes(phase) ? 12345 : null);
});
test('quick note writes locally and clears input on success', async () => {
  const save = jest.fn(async () => {});
  const view = await render(<QuickNote eventId="event-1" sessionId="session" phase="paused" elapsedMs={42000} save={save} />);
  await fireEvent.changeText(view.getByLabelText('Quick note'),'idea'); await fireEvent.press(view.getByLabelText('Add note'));
  await waitFor(() => expect(save).toHaveBeenCalledWith('event-1',{ text: 'idea', sessionId: 'session', timestampMs: 42000 }));
  expect(view.getByText('Saved on phone')).toBeTruthy(); expect(view.getByLabelText('Quick note').props.value).toBe('');
});
test('only finalized transcript rows expose long press and accessibility add action', async () => {
  const onAddNote = jest.fn(), row = { sequence: 0, startMs: 0, text: 'raw text', revision: 0 };
  const view = await render(<TranscriptRow row={row} onAddNote={onAddNote} />);
  await fireEvent(view.getByLabelText('Transcript: raw text'),'longPress');
  await fireEvent(view.getByLabelText('Transcript: raw text'),'accessibilityAction',{ nativeEvent: { actionName: 'addNote' } });
  expect(onAddNote).toHaveBeenCalledTimes(2);
  await view.rerender(<TranscriptRow row={{ ...row, partial: true }} onAddNote={onAddNote} />);
  expect(view.queryByLabelText('Transcript: raw text')).toBeNull();
  await view.rerender(<TranscriptRow row={{ ...row, failed: 'decode_failed' }} onAddNote={onAddNote} />);
  expect(view.queryByLabelText('Transcript: raw text')).toBeNull();
});
