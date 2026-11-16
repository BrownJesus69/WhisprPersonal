import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { TranslationControl } from '../components/TranslationControl';
import { TranslationList } from '../components/TranslationList';
import { TranscriptTabs } from '../components/TranscriptTabs';
import { Banner } from '../components/Banner';
import { useAI } from '../hooks/useAI';
import { translationRuntime } from '../lib/translation/runtime';
import { translationLabel, audioLabel } from '../lib/translation/labels';
import { UNAVAILABLE } from '../lib/translation/types';
import { transcriptRow } from '../lib/db/repositories';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { aiStatus } from './aiFixtures';
import { translation } from './translationFixtures';
import Settings from '../app/(app)/settings';
import { useConnectionStore } from '../state/connectionStore';
import { health } from './fixtures';

jest.mock('../hooks/useAI', () => ({ useAI: jest.fn() }));
jest.mock('../lib/translation/runtime', () => ({ translationRuntime: { get: jest.fn() } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
beforeEach(() => { jest.mocked(useAI).mockReturnValue({ status: { data: aiStatus(true) } } as never); });
test.each(['indictrans2','libretranslate','groq-audio-translation'] as const)('labels %s output with provenance and separate polish', async engine => {
  const r = translation({ engine, source_lang: engine === 'groq-audio-translation' ? 'und' : 'kn', polished_text: 'Polished translation', polish_provider: 'groq', polish_model: 'fixture-polish-model' });
  const view = await render(<TranslationList session={session()} originals={[transcriptRow(session().id,finalData())]} rows={[r]} target="en" />);
  expect(view.getByText(translationLabel(r))).toBeTruthy(); expect(view.getByText('Translated words')).toBeTruthy();
  expect(view.getByText('AI-polished (Groq · fixture-polish-model)')).toBeTruthy(); expect(view.getByText('Polished translation')).toBeTruthy();
  if (engine === 'groq-audio-translation') expect(view.getByText(audioLabel)).toBeTruthy();
});
test('missing and failed rows retain original words with Not translated label', async () => {
  const view = await render(<TranslationList session={session({ next_sequence: 2 })} originals={[transcriptRow(session().id,finalData()),transcriptRow(session().id,finalData({ sequence: 1, raw_text: 'Second original' }))]} rows={[translation({ text: null, engine: null, model: null, error_code: 'translation_unavailable' })]} target="en" />);
  expect(view.getAllByText('Not translated')).toHaveLength(2); expect(view.getByText('original')).toBeTruthy(); expect(view.getByText('Second original')).toBeTruthy();
});
test.each(['recording','paused','stopped','finalizing','interrupted'] as const)('Translate hidden for %s', async status => {
  const v = await render(<TranslationControl session={session({ status })} target="en" change={() => {}} />);
  expect(v.queryByLabelText('Translate')).toBeNull();
});
test.each([
  ['local_only',true,false,false], ['cloud_ai',true,false,true], ['local_only',false,true,true], [undefined,true,true,false],
] as const)('polish eligibility respects privacy %s', async (privacy,cloud,local,visible) => {
  jest.mocked(useAI).mockReturnValue({ status: { data: { ...aiStatus(cloud), local_available: local } } } as never);
  const v = await render(<TranslationControl session={session({ status: 'finalized' })} privacy={privacy} target="en" change={() => {}} />);
  expect(!!v.queryByLabelText('AI-polish the translation')).toBe(visible);
});
test('explicit target and polish are submitted; failure banner leaves Raw tab usable', async () => {
  const submit = jest.fn().mockRejectedValue(new Error('unavailable'));
  jest.mocked(translationRuntime.get).mockReturnValue({ submit } as never);
  function Harness() {
    const [tab,setTab] = useState<'raw'|'polished'|'translation'>('translation');
    return <><TranslationControl session={session({ status: 'finalized' })} privacy="cloud_ai" target="ta" change={() => {}} /><TranscriptTabs translation selected={tab} onSelect={setTab} />{tab === 'raw' && <Banner message="Original transcript" />}</>;
  }
  const v = await render(<Harness />);
  await fireEvent(v.getByLabelText('AI-polish the translation'),'valueChange',true);
  await fireEvent.press(v.getByLabelText('Translate'));
  await waitFor(() => expect(v.getByText(UNAVAILABLE)).toBeTruthy());
  expect(submit).toHaveBeenCalledWith({ event_id: 'event-1', session_ids: [session().id], target_lang: 'ta', polish: true });
  await fireEvent.press(v.getByLabelText('Raw')); expect(v.getByText('Original transcript')).toBeTruthy();
});
test('Settings shows disabled future integrations and separate laptop translation', async () => {
  useConnectionStore.setState({ status: 'connected', health: { ...health, integrations: { calendar: { enabled: false, status: 'disabled', docs: 'docs/integrations.md#calendar' } } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const v = await render(<QueryClientProvider client={client}><Settings /></QueryClientProvider>);
  await fireEvent.press(v.getByLabelText('Advanced'));
  expect(v.getByText('Translation (on your laptop)')).toBeTruthy(); expect(v.getByText('Future integrations')).toBeTruthy();
  expect(v.getByText(/Disabled · Create and list calendar events/)).toBeTruthy();
  expect(v.getByText('Cloud Whisper')).toBeTruthy(); await v.unmount(); client.clear();
});
