import { FlatList } from 'react-native';
import { render,fireEvent,waitFor } from '@testing-library/react-native';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { useLocalSearchParams,router } from 'expo-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repositories,transcriptRow } from '../lib/db/repositories';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { getEvent,getCachedEvent,mapEvent } from '../lib/firebase/events';
import { authedClient } from '../lib/server/authedClient';
import { shareDocument } from '../lib/export/share';
import { useAuthStore } from '../state/authStore';
import Viewer from '../app/transcript/[sessionId]';
import Vocabulary from '../app/events/[eventId]/vocabulary';
import Export from '../app/events/[eventId]/export';
import EventDetail from '../app/events/[eventId]/index';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { note } from './noteFixtures';
import { draft } from './aiFixtures';
import { createNote } from '../lib/notes/notes';
import type { ServerClient } from '../lib/server/client';
jest.mock('../lib/db/repositories',() => ({ ...jest.requireActual('../lib/db/repositories'),repositories: jest.fn() }));
jest.mock('../lib/firebase/events',() => ({ ...jest.requireActual('../lib/firebase/events'),getEvent: jest.fn(),getCachedEvent: jest.fn() }));
jest.mock('../lib/server/authedClient',() => ({ authedClient: jest.fn() }));
jest.mock('../lib/export/share',() => ({ shareDocument: jest.fn(async () => {}) }));
jest.mock('../lib/notes/notes',() => ({ ...jest.requireActual('../lib/notes/notes'),createNote: jest.fn(async () => 'note'),listNotes: jest.fn(async () => []) }));
const event = mapEvent('event-1',{ ownerId: 'owner',title: 'Rehearsal',speakers: ['Aditya'],status: 'completed' });
let repo: MemoryRepositories;
beforeEach(async () => {
  repo = new MemoryRepositories(); jest.mocked(repositories).mockResolvedValue(repo);
  useAuthStore.getState().setUser({ uid: 'owner',email: null,provider: 'password' });
  jest.mocked(useLocalSearchParams).mockReturnValue({ sessionId: session().id,eventId: 'event-1',sequence: '1' });
  jest.mocked(getEvent).mockResolvedValue(event); jest.mocked(getCachedEvent).mockResolvedValue(event);
  jest.mocked(authedClient).mockReturnValue(null);
  await repo.putSession(session({ status: 'finalized',next_sequence: 2,finalize_status: 'complete' }));
  await repo.upsertTranscript(transcriptRow(session().id,finalData({ raw_text: 'First row' })));
  await repo.upsertTranscript(transcriptRow(session().id,finalData({ sequence: 1,start_ms: 10000,raw_text: 'Second row' })));
});
async function mount(component: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false,gcTime: 0 },mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
}
test('viewer is local, searchable, labelled and adds raw text to notes', async () => {
  const scroll = jest.spyOn(FlatList.prototype,'scrollToIndex').mockImplementation(() => {});
  const view = await mount(<Viewer />); await view.findByText('First row');
  await fireEvent(view.getByLabelText('Saved transcript rows'),'contentSizeChange',400,2000);
  expect(scroll).toHaveBeenCalledWith({ index: 1,animated: false }); scroll.mockRestore();
  expect(view.getByText('Second row')).toBeTruthy(); expect(view.queryByLabelText('Jump to live')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('Search transcript'),'Second');
  expect(view.queryByText('First row')).toBeNull(); expect(view.getByText('Second row')).toBeTruthy();
  await fireEvent(view.getByLabelText('Transcript: Second row'),'longPress');
  await waitFor(() => expect(createNote).toHaveBeenCalledWith('event-1',expect.objectContaining({ text: 'Second row',sequence: 1,source: 'transcript' })));
  await fireEvent.press(view.getByLabelText('Polished')); expect(view.getByText('Not cleaned')).toBeTruthy();
  expect(authedClient).not.toHaveBeenCalled(); await view.unmount();
});
test('vocabulary loads, adds speakers and validates before saving reserved empty replacements', async () => {
  const client = { get: jest.fn(async () => ({ terms: ['Place'] })),post: jest.fn(async () => ({})) };
  jest.mocked(authedClient).mockReturnValue(client as unknown as ServerClient);
  const view = await mount(<Vocabulary />); await waitFor(() => expect(view.getByLabelText('Terms (one per line)').props.value).toBe('Place'));
  await fireEvent.press(view.getByLabelText('Add event speakers'));
  expect(view.getByLabelText('Terms (one per line)').props.value).toContain('Aditya');
  await fireEvent.press(view.getByLabelText('Save vocabulary'));
  await waitFor(() => expect(client.post).toHaveBeenCalledWith('/api/v1/vocabulary',{ event_id: 'event-1',terms: ['Place','Aditya'],replacements: [] }));
  await fireEvent.changeText(view.getByLabelText('Terms (one per line)'),'x'.repeat(65));
  await fireEvent.press(view.getByLabelText('Save vocabulary')); expect(view.getByText('Use at most 200 terms, each 64 characters or fewer.')).toBeTruthy();
  await view.unmount();
});
test('vocabulary unavailable prevents destructive overwrite of unseen terms', async () => {
  const view = await mount(<Vocabulary />); await view.findByText('Laptop unavailable. Connect and reload vocabulary before editing.');
  expect(view.getByLabelText('Save vocabulary').props.accessibilityState.disabled).toBe(true); await view.unmount();
});
test('export defaults raw, all transcript sessions, notes and no brief; saved brief is opt-in', async () => {
  await repo.putNote(note()); await repo.putBriefDraft(draft({ status: 'saved',edited_text: 'Reviewed brief' }));
  const view = await mount(<Export />); await view.findByLabelText(/Markdown/);
  await waitFor(() => expect(view.getByLabelText('Export').props.accessibilityState.disabled).toBe(false));
  expect(view.getByLabelText('PDF \u2014 not available yet').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('Export')); await waitFor(() => expect(shareDocument).toHaveBeenCalledTimes(1));
  let doc = jest.mocked(shareDocument).mock.calls[0][0]; expect(doc.content).toContain('Local note'); expect(doc.content).toContain('First row'); expect(doc.content).not.toContain('Reviewed brief');
  await view.findByText('Export opened in the share sheet.');
  await fireEvent.press(view.getByLabelText('Saved brief 1: Reviewed brief')); await fireEvent.press(view.getByLabelText('Export'));
  await waitFor(() => expect(shareDocument).toHaveBeenCalledTimes(2)); doc = jest.mocked(shareDocument).mock.calls[1][0]; expect(doc.content).toContain('Reviewed brief');
  expect(getCachedEvent).toHaveBeenCalled(); expect(getEvent).not.toHaveBeenCalled(); await view.unmount();
});
test('completed event links to transcript, brief, export, and vocabulary under More', async () => {
  const view = await mount(<EventDetail />); await view.findByLabelText('View transcript');
  await fireEvent.press(view.getByLabelText('View transcript')); expect(router.push).toHaveBeenCalledWith({ pathname: '/transcript/[sessionId]',params: { sessionId: session().id } });
  expect(view.getByLabelText('Brief')).toBeTruthy(); expect(view.getByLabelText('Export')).toBeTruthy();
  expect(view.getByLabelText('Start recording')).toBeTruthy(); expect(view.queryByLabelText('Vocabulary')).toBeNull();
  await fireEvent.press(view.getByLabelText('More')); expect(view.getByLabelText('Vocabulary')).toBeTruthy(); await view.unmount();
});
test('all Phase 9 routes are registered with titles', () => {
  const layout = readFileSync(resolve(process.cwd(),'src/app/_layout.tsx'),'utf8');
  for (const [name,title] of [['transcript/[sessionId]','Transcript'],['events/[eventId]/export','Export'],['events/[eventId]/vocabulary','Vocabulary'],['diagnostics','Diagnostics']]) expect(layout).toContain(`name="${name}" options={{ title: '${title}' }}`);
});
