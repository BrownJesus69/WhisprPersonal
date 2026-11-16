import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Share } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import HistoryDetail from '@/app/history/[sessionId]';
import { repositories, transcriptRow } from '@/lib/db/repositories';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { removePhoneAudio, removeRecording } from '@/features/speak/retention';
import { draftKey } from '@/features/speak/drafts';
import { kv } from '@/lib/storage/kv';
import { useAuthStore } from '@/state/authStore';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { t } from '@/i18n';
import { TranscriptResult } from '@/components/ui/TranscriptResult';
jest.mock('@/lib/db/repositories', () => ({ ...jest.requireActual('@/lib/db/repositories'), repositories: jest.fn() }));
jest.mock('@/features/speak/retention', () => ({ removePhoneAudio: jest.fn(async () => {}), removeRecording: jest.fn(async () => ({ pending: false })) }));
let repo: MemoryRepositories;
beforeEach(async () => {
  repo = new MemoryRepositories(); jest.mocked(repositories).mockResolvedValue(repo);
  useAuthStore.getState().setUser({ uid: 'owner', email: null, provider: 'password' });
  jest.mocked(useLocalSearchParams).mockReturnValue({ sessionId: session().id });
  await kv.removeItem(draftKey('owner', session().id));
  await kv.removeItem(draftKey('owner', session().id, true));
});
async function detail(finalized = true) {
  await repo.putSession(session({ status: finalized ? 'finalized' : 'finalizing' }));
  await repo.upsertTranscript({ ...transcriptRow(session().id, finalData({ raw_text: 'Original words' })), polished_text: 'Clean words.' });
  await repo.storePolished(session().id, [{ sequence: 0, polished_text: 'Clean words.', polished_level: 'conservative', polish_error: null }], await repo.transcript(session().id));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const v = await render(<QueryClientProvider client={client}><HistoryDetail /></QueryClientProvider>);
  await v.findByLabelText(t('copy'));
  await waitFor(() => expect(v.getByLabelText(t('transcript'))).toHaveDisplayValue('Original words'));
  return { v, client };
}
test('edits use Speak draft keys; Copy, Share, variants and timestamps work', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const { v, client } = await detail();
  await fireEvent.changeText(v.getByLabelText(t('transcript')), 'Edited words');
  await fireEvent.press(v.getByLabelText(t('copy')));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Edited words'); expect(v.getByText(t('copied'))).toBeTruthy();
  expect(await kv.getItem(draftKey('owner', session().id))).toBe('Edited words');
  await fireEvent.press(v.getByLabelText(t('share'))); expect(share).toHaveBeenCalledWith({ message: 'Edited words' });
  await fireEvent.press(v.getByLabelText(t('more')));
  await fireEvent.press(v.getByLabelText(t('cleaned'))); await waitFor(() => expect(v.getByLabelText(t('transcript'))).toHaveDisplayValue('Clean words.'));
  await fireEvent.press(v.getByLabelText(t('original'))); await waitFor(() => expect(v.getByLabelText(t('transcript'))).toHaveDisplayValue('Edited words'));
  await fireEvent.press(v.getByLabelText(t('timestamps'))); expect(router.push).toHaveBeenCalledWith({ pathname: '/transcript/[sessionId]', params: { sessionId: session().id } });
  expect((await repo.transcript(session().id))[0].raw_text).toBe('Original words');
  await v.unmount(); client.clear(); share.mockRestore();
});
test.each([true, false])('delete audio is enabled only for finalized=%s and requires confirmation', async finalized => {
  const alert = jest.spyOn(Alert, 'alert'); const { v, client } = await detail(finalized);
  await fireEvent.press(v.getByLabelText(t('more'))); await fireEvent.press(v.getByLabelText(t('delete')));
  if (!finalized) { expect(v.getByLabelText(t('deleteAudio'))).toBeDisabled(); expect(v.getByText(t('audioNotReady'))).toBeTruthy(); }
  else {
    await fireEvent.press(v.getByLabelText(t('deleteAudio')));
    expect(alert).toHaveBeenLastCalledWith(t('deleteAudioTitle'), t('deleteAudioBody'), expect.any(Array));
    expect(removePhoneAudio).not.toHaveBeenCalled();
    await act(async () => { alert.mock.calls.at(-1)![2]![1].onPress?.(); });
    expect(removePhoneAudio).toHaveBeenCalledWith('owner', session().id); expect(removeRecording).not.toHaveBeenCalled();
    expect(v.getByText(t('audioDeleted'))).toBeTruthy();
  }
  await v.unmount(); client.clear(); alert.mockRestore();
});
test('recording and text deletion confirms the device scope and removes through deleteSession helper', async () => {
  const alert = jest.spyOn(Alert, 'alert'); const { v, client } = await detail();
  await fireEvent.press(v.getByLabelText(t('more'))); await fireEvent.press(v.getByLabelText(t('delete')));
  await fireEvent.press(v.getByLabelText(t('deleteText')));
  expect(alert).toHaveBeenLastCalledWith(t('deleteTitle'), t('deleteTextBody'), expect.any(Array));
  expect(removeRecording).not.toHaveBeenCalled();
  await act(async () => { alert.mock.calls.at(-1)![2]![1].onPress?.(); });
  expect(removeRecording).toHaveBeenCalledWith('owner', session().id); expect(router.back).toHaveBeenCalled();
  await v.unmount(); client.clear(); alert.mockRestore();
});
test('another account cannot view or edit a recording', async () => {
  await repo.putSession(session({ owner_uid: 'other' }));
  const client = new QueryClient(); const v = await render(<QueryClientProvider client={client}><HistoryDetail /></QueryClientProvider>);
  await v.findByText(t('missingRecording')); expect(v.queryByLabelText(t('transcript'))).toBeNull();
  await v.unmount(); client.clear();
});
test('Copy still rescues edited text when draft storage fails', async () => {
  const v = await render(<TranscriptResult session={session({ status: 'finalized' })} text="Unsaved edit" edit={() => {}} cleaned={false} changeCleaned={async () => {}} hasPolished={false} flush={async () => { throw new Error('storage'); }} remove={async () => {}} />);
  await fireEvent.press(v.getByLabelText(t('copy')));
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Unsaved edit');
  expect(v.getByText(t('draftFailed'))).toBeTruthy(); await v.unmount();
});
