import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';
import Speak from '@/app/(app)/index';
import { useSpeak } from '@/features/speak/useSpeak';
import { emptyView } from '@/lib/live/transcriptStore';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { t } from '@/i18n';
import { session } from './recordingFixtures';
jest.mock('@/features/speak/useSpeak', () => ({ useSpeak: jest.fn() }));
jest.mock('@/lib/session/recordingStore', () => {
  const { create } = jest.requireActual('zustand');
  return { useRecordingStore: create(() => ({ dbfs: -96 })) };
});
const start = jest.fn(async () => {}), stop = jest.fn(async () => {}), remove = jest.fn(async () => {});
function model(patch = {}) {
  return { state: 'idle', disconnected: false, session: null, rows: [], draft: '', editDraft: jest.fn(), cleaned: false, changeCleaned: jest.fn(), error: '', draftError: false, flushDraft: jest.fn(async () => {}), start, stop, finish: jest.fn(), remove, interrupted: false,
    recording: { sessionId: null, phase: 'idle', elapsedMs: 0, warning: '', message: '' }, live: emptyView, raw: '', ...patch };
}
beforeEach(() => { useSettingsStore.setState(defaults); jest.mocked(useSpeak).mockReturnValue(model() as never); });
test('at rest there is exactly one primary button, Start speaking', async () => {
  const view = await render(<Speak />);
  const buttons = view.getAllByRole('button');
  expect(buttons.map(b => b.props.accessibilityLabel)).toEqual(expect.arrayContaining([t('start')]));
  expect(view.getAllByRole('button', { name: t('start') })).toHaveLength(1);
  // The other visible controls are status and language, both quiet controls.
  expect(buttons).toHaveLength(3);
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: t('start') })); expect(start).toHaveBeenCalledTimes(1);
});
test('language choice persists in two taps and updates the chip', async () => {
  const view = await render(<Speak />);
  await fireEvent.press(view.getByRole('button', { name: t('languageChip', { name: t('auto') }) }));
  await fireEvent.press(view.getByRole('button', { name: t('kn') }));
  expect(useSettingsStore.getState()).toMatchObject({ defaultLanguageMode: 'kn', recentLanguages: ['kn'] });
  expect(view.getByRole('button', { name: t('languageChip', { name: t('kn') }) })).toBeTruthy();
});
test('Copy writes only on press and displays inline feedback for two seconds', async () => {
  jest.useFakeTimers();
  jest.mocked(useSpeak).mockReturnValue(model({ state: 'complete', session: session(), draft: 'my words' }) as never);
  const view = await render(<Speak />);
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: t('copy') }));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('my words'); expect(view.getByText(t('copied'))).toBeTruthy();
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); }); expect(view.queryByText(t('copied'))).toBeNull();
  jest.useRealTimers();
});
test('Cancel offers Keep, Discard and back; Keep and Discard use distinct actions', async () => {
  jest.mocked(useSpeak).mockReturnValue(model({ state: 'listening', session: session() }) as never);
  const alert = jest.spyOn(Alert, 'alert'); const view = await render(<Speak />);
  await fireEvent.press(view.getByRole('button', { name: t('cancel') }));
  const choices = alert.mock.calls[0][2]!;
  expect(choices.map(c => c.text)).toEqual([t('backRecording'), t('keep'), t('discard')]);
  await act(async () => { choices[1].onPress?.(); }); expect(stop).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
  await act(async () => { choices[2].onPress?.(); }); expect(remove).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});
