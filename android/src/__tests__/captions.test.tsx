import { act, fireEvent, render } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { StyleSheet } from 'react-native';
import { light } from '@/theme/colors';
import Captions from '@/app/captions';
import Speak from '@/app/(app)/index';
import { useSpeak } from '@/features/speak/useSpeak';
import { captionsAvailable, followsLatest } from '@/features/speak/captions';
import { initialTranscript, apply } from '@/lib/live/transcriptModel';
import { useTranscriptStore, emptyView } from '@/lib/live/transcriptStore';
import { useSettingsStore, defaults, normalizeSettings } from '@/state/settingsStore';
import { useConnectionStore } from '@/state/connectionStore';
import { t } from '@/i18n';
import { finalEvent } from './liveFixtures';
import { health } from './fixtures';
jest.mock('expo-keep-awake', () => {
  const awake = { active: false };
  return { awake, useKeepAwake: jest.fn(() => {
    jest.requireActual('react').useEffect(() => { awake.active = true; return () => { awake.active = false; }; }, []);
  }) };
});
jest.mock('@/features/speak/useSpeak', () => ({ useSpeak: jest.fn() }));
const stop = jest.fn(), start = jest.fn();
function model(state = 'idle') {
  return { state, session: null, rows: [], live: emptyView, recording: { phase: state === 'listening' ? 'recording' : 'idle', elapsedMs: 0 }, stop, start };
}
beforeEach(() => {
  useSettingsStore.setState(defaults); useConnectionStore.setState({ status: 'disconnected', health });
  jest.mocked(useSpeak).mockReturnValue(model() as never);
});
test('entry requires a connected computer, ready health and an observed live stream', async () => {
  expect(captionsAvailable('connected', health, 'live')).toBe(true);
  expect(captionsAvailable('disconnected', health, 'live')).toBe(false);
  expect(captionsAvailable('connected', { ...health, model: { ...health.model, status: 'loading' } }, 'live')).toBe(false);
  expect(captionsAvailable('connected', health, 'offline')).toBe(false);
  const view = await render(<Speak />);
  expect(view.queryByLabelText(t('more'))).toBeNull();
  expect(view.queryByLabelText(t('captions'))).toBeNull();
  await act(async () => { useConnectionStore.setState({ status: 'connected' }); });
  jest.mocked(useSpeak).mockReturnValue({ ...model(), live: { ...emptyView, status: 'live' } } as never);
  await view.rerender(<Speak />);
  await fireEvent.press(view.getByLabelText(t('more')));
  expect(view.getByLabelText(t('captions'))).toBeTruthy();
});
test('following pauses above the latest captions and Jump resumes it', async () => {
  expect(followsLatest(0, 2000, 400)).toBe(false);
  expect(followsLatest(1600, 2000, 400)).toBe(true);
  const view = await render(<Captions />);
  await fireEvent.scroll(view.getByTestId('captions-scroll'), { nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 400 } } });
  await fireEvent.press(view.getByLabelText(t('jumpLatest')));
  expect(view.queryByLabelText(t('jumpLatest'))).toBeNull();
});
test('reconnect replay retains finalized segments once and removes matching provisionals', () => {
  let model = apply(initialTranscript(), finalEvent(1));
  model = apply(model, finalEvent(1));
  expect(model.finals.size).toBe(1);
  useTranscriptStore.setState({ sessions: {} });
  const store = useTranscriptStore.getState(); store.dispatch(finalEvent(1));
  store.reset(finalEvent().session_id); store.dispatch(finalEvent(1)); store.dispatch(finalEvent(2, { sequence: 1 }));
  const replay = useTranscriptStore.getState().sessions[finalEvent().session_id].model;
  expect([...replay.finals.keys()]).toEqual([0, 1]);
  expect(replay.partials.size).toBe(0);
});
test('keep awake is mounted only while listening; leaving does not stop recording', async () => {
  const view = await render(<Captions />); expect(useKeepAwake).not.toHaveBeenCalled();
  jest.mocked(useSpeak).mockReturnValue(model('listening') as never);
  await view.rerender(<Captions />); expect(useKeepAwake).toHaveBeenCalledWith('live-captions');
  expect(jest.requireMock('expo-keep-awake').awake.active).toBe(true);
  await act(async () => { const blur = jest.mocked(useFocusEffect).mock.calls.at(-1)![0](); if (blur) blur(); });
  expect(jest.requireMock('expo-keep-awake').awake.active).toBe(false);
  jest.mocked(useKeepAwake).mockClear();
  jest.mocked(useSpeak).mockReturnValue(model('processing') as never);
  await view.rerender(<Captions />); expect(useKeepAwake).not.toHaveBeenCalled();
  await view.unmount(); expect(stop).not.toHaveBeenCalled();
});
test('caption size persists and clamps to 20–40 sp', async () => {
  const view = await render(<Captions />);
  await fireEvent.press(view.getByLabelText(t('captionLarger')));
  expect(useSettingsStore.getState().captionSize).toBe(30);
  expect(normalizeSettings({ captionSize: 200 }).captionSize).toBe(40);
  expect(normalizeSettings({ captionSize: 1 }).captionSize).toBe(20);
});

test('captions distinguish finalized and provisional text and show reconnecting', async () => {
  const live = { ...emptyView, status: 'reconnecting' as const, model: apply(initialTranscript(), finalEvent(1, { raw_text: 'Final words' })) };
  live.model.partials.set(1, [{ text: 'Still speaking', start_ms: 10000, end_ms: 11000 }]);
  jest.mocked(useSpeak).mockReturnValue({ ...model('listening'), live } as never);
  const view = await render(<Captions />);
  expect(view.getByLabelText(t('reconnecting'))).toBeTruthy();
  expect(StyleSheet.flatten(view.getByText('Final words').props.style)).toMatchObject({ color: light.text, fontSize: 28 });
  expect(StyleSheet.flatten(view.getByText('Still speaking').props.style)).toMatchObject({ color: light.muted, fontStyle: 'italic', fontSize: 28 });
});
