import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import History from '@/app/(app)/history';
import { repositories, transcriptRow } from '@/lib/db/repositories';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { useAuthStore } from '@/state/authStore';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { t } from '@/i18n';
jest.mock('@/lib/db/repositories', () => ({ ...jest.requireActual('@/lib/db/repositories'), repositories: jest.fn() }));
test('renders newest-first date groups, searches previews, copies on tap and links Events', async () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date(2026,10,16,12));
  const repo = new MemoryRepositories(); jest.mocked(repositories).mockResolvedValue(repo);
  useAuthStore.getState().setUser({ uid: 'owner', email: null, provider: 'password' });
  for (const [id, date, text] of [['today', new Date(2026,10,16,10), 'today words'], ['yesterday', new Date(2026,10,15,10), 'yesterday words'], ['earlier', new Date(2026,10,1,10), 'earlier words']] as const) {
    await repo.putSession(session({ id, created_at: date.toISOString(), status: 'finalized' }));
    await repo.upsertTranscript(transcriptRow(id, finalData({ raw_text: text })));
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const view = await render(<QueryClientProvider client={client}><History /></QueryClientProvider>);
  await waitFor(() => expect(view.getByText(t('today'))).toBeTruthy());
  const headers = view.getAllByRole('header'); expect(headers.map(h => h.props.children)).toEqual([t('history'),t('today'),t('yesterday'),t('earlier')]);
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  await fireEvent.press(view.getAllByRole('button', { name: t('copy') })[0]); expect(Clipboard.setStringAsync).toHaveBeenCalledWith('today words');
  await fireEvent.changeText(view.getByLabelText(t('searchHistory')), 'yesterday');
  expect(view.queryByText('today words')).toBeNull(); expect(view.getByText('yesterday words')).toBeTruthy();
  await fireEvent.press(view.getByText('yesterday words')); expect(router.push).toHaveBeenCalledWith({ pathname: '/transcript/[sessionId]', params: { sessionId: 'yesterday' } });
  await fireEvent.press(view.getByRole('button', { name: t('eventsLink') })); expect(router.push).toHaveBeenCalledWith('/events');
  await view.unmount(); client.clear(); jest.useRealTimers();
});
