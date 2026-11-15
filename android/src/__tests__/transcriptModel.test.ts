import { apply, initialTranscript } from '../lib/live/transcriptModel';
import { parseEvent, type PersistedEvent, type PartialEvent } from '../lib/live/events';
import { finalData, finalEvent, liveId } from './liveFixtures';
const partial: PartialEvent = { type: 'transcript_partial', session_id: liveId, chunk_id: 'c', sequence: 0, data: { start_ms: 50, end_ms: 100, text: 'decoding' } };
test('final/revised replace a sequence, clear partials; duplicate replay ignored', () => {
  const start = initialTranscript();
  const p = apply(start, partial); expect(p.partials.get(0)?.[0].start_ms).toBe(50);
  const final = apply(p, finalEvent()); expect(final.partials.size).toBe(0);
  expect(apply(final, partial)).toBe(final);
  const revised = apply(final, finalEvent(2, { raw_text: 'restitch' }, true));
  expect(revised.finals.get(0)).toMatchObject({ raw_text: 'restitch', revision: 1 });
  expect(revised.finals.size).toBe(1); expect(final.finals.get(0)?.raw_text).toBe('original');
  expect(apply(revised, finalEvent(2))).toBe(revised);
});
test('sequence sort, silence skipped in timeline, current latest non-silent final', () => {
  let state = initialTranscript();
  for (const [i,sequence,language,silent] of [[1,4,'hi',false],[2,0,'kn',false],[3,1,'ta',true],[4,2,'kn',false],[5,3,'ta',false],[6,5,'en',true]] as const) state = apply(state, finalEvent(i, { sequence, detected_language: language, no_speech: silent, language_uncertain: sequence === 4 }));
  expect([...state.finals.keys()]).toEqual([0,1,2,3,4,5]);
  expect(state.language.timeline).toEqual([{ language: 'kn', fromSequence: 0, toSequence: 2 }, { language: 'ta', fromSequence: 3, toSequence: 3 }, { language: 'hi', fromSequence: 4, toSequence: 4 }]);
  expect(state.language).toMatchObject({ current: 'hi', confidence: 0.92, uncertain: true });
});
test('failed part and lifecycle/language events survive reduction', () => {
  let state = apply(initialTranscript(), partial);
  const base = { session_id: liveId, ts: 'now' };
  const events: PersistedEvent[] = [
    { ...base, type: 'chunk_failed', seq: 1, data: { chunk_id: 'c', sequence: 0, error_code: 'decode_failed' } },
    { ...base, type: 'language_locked', seq: 2, data: { language: 'kn', confidence: 0.9, at_sequence: 0 } },
    { ...base, type: 'language_changed', seq: 3, data: { from: 'kn', to: 'ta', at_sequence: 1 } },
    { ...base, type: 'language_override', seq: 4, data: { language: 'hi', by: 'owner' } },
    { ...base, type: 'session_finalized', seq: 5, data: { transcript_status: 'partial', missing_sequences: [1], failed_sequences: [0] } }
  ];
  for (const event of events) { expect(parseEvent(event)).not.toBeNull(); state = apply(state, event); }
  expect(state.failed.get(0)).toBe('decode_failed'); expect(state.partials.size).toBe(0);
  expect(state.language.mode).toBe('hi'); expect(state.finalized).toEqual({ transcriptStatus: 'partial', missing: [1], failed: [0] });
});
test.each([
  null, {}, '{', { type: 'hello', session_id: liveId, status: 'active', last_event_seq: -1, server_time: 'now' },
  { ...finalEvent(), seq: 1.5 }, { ...finalEvent(), data: finalData({ language_confidence: 1.1 }) },
  { ...finalEvent(), data: { ...finalData(), language_uncertain: 1 } },
  { ...finalEvent(), data: finalData({ segments: [{ start_ms: 10, end_ms: 1, text: 'bad' }] }) },
  { ...partial, data: { ...partial.data, start_ms: NaN } },
  { type: 'error', code: 'reflected private value' }
])('malformed event is rejected %#', event => expect(parseEvent(event)).toBeNull());
