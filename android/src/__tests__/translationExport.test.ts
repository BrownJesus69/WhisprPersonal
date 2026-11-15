import { composeEventExport } from '../lib/export/compose';
import { translationLabel, audioLabel } from '../lib/translation/labels';
import { translationDiagnostics } from '../lib/export/diagnostics';
import { integrationStatuses } from '../features/integrations';
import { parseEvent } from '../lib/live/events';
import { mapEvent } from '../lib/firebase/events';
import { transcriptRow } from '../lib/db/repositories';
import { translation, translationStatus } from './translationFixtures';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
const input = { event: mapEvent('event-1',{ title: 'Event', ownerId: 'owner' }), sessions: [session()], transcripts: [transcriptRow(session().id,finalData())], notes: [], format: 'md' as const, text: 'raw' as const };
test.each(['md','txt'] as const)('translation export %s is optional and every line labelled after transcript', format => {
  expect(composeEventExport({ ...input,format }).content).not.toContain('Translation (');
  const r = translation({ text: 'First translated line\nSecond translated line', polished_text: 'Polished words', polish_provider: 'groq', polish_model: 'fixture-polish-model' });
  const text = composeEventExport({ ...input,format, translation: { target: 'en', rows: [r] } }).content;
  expect(text.indexOf('Translation (English)')).toBeGreaterThan(text.indexOf('Transcript'));
  expect(text).toContain('original');
  for (const line of text.split('\n').filter(l => /translated line|Polished words/.test(l))) expect(line).toContain(translationLabel(r));
  expect(text).toContain('AI-polished (Groq · fixture-polish-model)');
  expect(composeEventExport({ ...input, translation: { target: 'en', rows: [] } }).content).toContain('Not translated: original');
});
test('export explicitly labels emergency audio with und source', () => {
  const r = translation({ source_lang: 'und', engine: 'groq-audio-translation' });
  expect(composeEventExport({ ...input,transcripts: [],translation: { target: 'en', rows: [r] } }).content).toContain(audioLabel);
});
test('diagnostics whitelist engine states and pairs, never arbitrary reflected text', () => {
  const status = translationStatus();
  expect(translationDiagnostics(status)).toContainEqual({ label: 'IndicTrans2 indic_en', value: 'loaded' });
  expect(translationDiagnostics(status)).toContainEqual({ label: 'LibreTranslate hi-en', value: 'disabled · eligible · unavailable' });
  const text = JSON.stringify(translationDiagnostics({ indictrans2: { indic_en: 'SECRET' }, libretranslate: { 'SECRET': { enabled: true } }, groq_audio: { configured: 'SECRET' } }));
  expect(text).not.toContain('SECRET'); expect(text).toContain('not_configured');
});
test('offline future list excludes Translation and has no active controls', () => {
  const rows = integrationStatuses(); expect(rows).toHaveLength(7); expect(rows.map(r => r.name)).not.toContain('Translation');
  expect(rows.every(r => !r.enabled && r.status === 'Not configured')).toBe(true);
});
test('stream validator accepts only validated audio event and safely ignores unknown types', () => {
  const event = { type: 'chunk_audio_translated', seq: 7, session_id: session().id, ts: '2026-11-16T00:00:00Z', data: { sequence: 0, target_lang: 'en', engine: 'groq-audio-translation' } };
  expect(parseEvent(event)).toEqual(event);
  expect(parseEvent({ ...event,data: { ...event.data,target_lang: 'ta' } })).toBeNull();
  expect(parseEvent({ ...event,type: 'future_event' })).toBeNull();
  expect(parseEvent({ type: 'ping' })).toEqual({ type: 'ping' });
});
