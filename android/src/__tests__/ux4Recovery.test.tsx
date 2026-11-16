import { act, fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, BackHandler, Share } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Speak from '@/app/(app)/index';
import Setup from '@/app/setup';
import { useSpeak } from '@/features/speak/useSpeak';
import { emptyView } from '@/lib/live/transcriptStore';
import { useConnectionStore } from '@/state/connectionStore';
import { defaults, useSettingsStore } from '@/state/settingsStore';
import { uploadService } from '@/lib/upload/uploadService';
import { transcriptRow } from '@/lib/db/repositories';
import { RecognitionNotice } from '@/components/ui/RecognitionNotice';
import { TranscriptResult } from '@/components/ui/TranscriptResult';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { withDeadline } from '@/lib/deadline';
import { t } from '@/i18n';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { health } from './fixtures';
jest.mock('@/features/speak/useSpeak', () => ({ useSpeak: jest.fn() }));
jest.mock('@/lib/upload/uploadService', () => ({ uploadService: { retryFailed: jest.fn(async () => {}) } }));
const again = jest.fn(async () => {}), cleanup = jest.fn(async () => {});
function model(patch = {}) {
  return { state: 'idle', session: null, rows: [], draft: '', live: emptyView, recording: { phase: 'idle', elapsedMs: 0 }, start: again, retry: again, retryCleanup: cleanup, flushDraft: again, ...patch };
}
beforeEach(() => { useSettingsStore.setState(defaults); useConnectionStore.setState({ status: 'connected', health: null }); });
test.each([
  [{ state: 'permission_denied' }, 'permission', 'nothingRecorded', 'openSettings'],
  [{ state: 'microphone_unavailable' }, 'micBusy', 'nothingRecorded', 'retry'],
  [{ state: 'complete', session: session({ status: 'finalized' }) }, 'noSpeech', 'keptHistory', 'retry'],
  [{ state: 'failed', session: session({ status: 'failed' }) }, 'recognitionFailed', 'recognitionAudioSafe', 'retry'],
  [{ state: 'processing', session: session(), disconnected: true }, 'offlineProcessing', 'safe', 'connect'],
  [{ state: 'slow', session: session() }, 'slow', 'safe', 'openHistory'],
  [{ cleanupNotice: t('cleanupFailed'), session: session() }, 'cleanupFailed', 'originalSafe', 'retry'],
  [{ draftError: true }, 'draftFailed', 'draftUnsafe', 'retry'],
  [{ interrupted: true }, 'interrupted', 'safe', 'finish'],
] as const)('Speak covers recovery %s', async (patch, title, safety, action) => {
  jest.mocked(useSpeak).mockReturnValue(model(patch) as never);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const view = await render(<Speak />);
  expect(view.getByText(t(title))).toBeTruthy(); expect(view.getByText(t(safety))).toBeTruthy();
  expect(view.getAllByLabelText(t(action)).length).toBeGreaterThan(0);
  expect(announce).toHaveBeenCalledWith(t(title));
  announce.mockRestore();
});
test.each(['renew_required', 'loading'] as const)('computer recovery: %s', async state => {
  useConnectionStore.setState(state === 'renew_required' ? { status: state } : { health: { ...health, model: { ...health.model, status: state } } });
  jest.mocked(useSpeak).mockReturnValue(model({ session: session({ consent_at: 'now' }) }) as never);
  const view = await render(<Speak />);
  expect(view.getByText(t(state === 'loading' ? 'modelStarting' : 'computerSignIn'))).toBeTruthy();
  expect(view.getByText(t('safe'))).toBeTruthy();
});
test('failed rows retry uploads; silence starts another recording and deleted audio is not claimed safe', async () => {
  const row = { ...transcriptRow(session().id, finalData()), failed_code: 'recognition_failed' };
  const view = await render(<RecognitionNotice session={session({ status: 'finalized' })} rows={[row]} again={again} />);
  await fireEvent.press(view.getByLabelText(t('retry')));
  expect(uploadService.retryFailed).toHaveBeenCalledWith(session().id);
  await view.rerender(<RecognitionNotice session={session({ status: 'failed', master_uri: '' })} rows={[row]} again={again} />);
  expect(view.queryByText(t('recognitionAudioSafe'))).toBeNull();
  await view.rerender(<RecognitionNotice session={session({ status: 'finalized' })} rows={[{ ...row, failed_code: null, no_speech: true }]} again={again} />);
  await fireEvent.press(view.getByLabelText(t('retry'))); expect(again).toHaveBeenCalled();
});
test('share rejection preserves text and Try again retries sharing', async () => {
  const share = jest.spyOn(Share, 'share').mockRejectedValueOnce(new Error('no share')).mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const view = await render(<TranscriptResult session={session()} text="kept words" edit={jest.fn()} cleaned={false} changeCleaned={again} hasPolished={false} flush={again} remove={again} />);
  await fireEvent.press(view.getByLabelText(t('share')));
  expect(view.getByText(t('shareFailed'))).toBeTruthy(); expect(view.getByText(t('textUnchanged'))).toBeTruthy();
  await fireEvent.press(view.getByLabelText(t('retry')));
  expect(share).toHaveBeenCalledTimes(2); expect(share).toHaveBeenLastCalledWith({ message: 'kept words' });
  share.mockRestore();
});
test('sharing with no result shows a failure notice at 30 seconds and releases buttons', async () => {
  jest.useFakeTimers();
  const share = jest.spyOn(Share, 'share').mockImplementation(() => new Promise(() => {}));
  const view = await render(<TranscriptResult session={session()} text="retained words" edit={jest.fn()} cleaned={false} changeCleaned={again} hasPolished={false} flush={again} remove={again} />);
  await fireEvent.press(view.getByLabelText(t('share')));
  expect(view.getByLabelText(t('share'))).toBeDisabled();
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  expect(view.getByText(t('shareFailed'))).toBeTruthy();
  expect(view.getByLabelText(t('share'))).not.toBeDisabled();
  await view.unmount(); share.mockRestore(); jest.useRealTimers();
});
test('pending network actions fail by 30 seconds and clear their timeout', async () => {
  jest.useFakeTimers();
  const result = withDeadline(new Promise(() => {}));
  const rejected = expect(result).rejects.toThrow('timeout');
  await act(async () => { await jest.advanceTimersByTimeAsync(30000); });
  await rejected; expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
});
test('sheet Back closes the modal, title is a header and reduced motion suppresses its slide', async () => {
  const reduced = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true), close = jest.fn();
  const view = await render(<BottomSheet visible title={t('more')} close={close} />);
  expect(view.getByRole('header', { name: t('more') })).toBeTruthy();
  expect(view.getByTestId('bottom-sheet-modal').props.animationType).toBe('none');
  await fireEvent(view.getByTestId('bottom-sheet-modal'), 'requestClose'); expect(close).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('bottom-sheet-content').props.accessibilityViewIsModal).toBe(true);
  reduced.mockRestore();
});
test('setup hardware Back returns to the previous step', async () => {
  const listener = jest.spyOn(BackHandler, 'addEventListener');
  const client = new QueryClient();
  const view = await render(<QueryClientProvider client={client}><Setup /></QueryClientProvider>);
  await fireEvent.press(view.getByLabelText(t('next')));
  const handler = listener.mock.calls.at(-1)![1];
  await act(async () => { expect(handler(undefined as never)).toBe(true); });
  expect(view.getByText(t('chooseLanguage'))).toBeTruthy(); listener.mockRestore();
});
