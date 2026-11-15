import type { FinalData, PersistedEvent } from '../lib/live/events';
export const liveId = 'ses_123456789012345678901234';
export const finalData = (patch: Partial<FinalData> = {}): FinalData => ({
  chunk_id: 'chunk_0', sequence: 0, start_ms: 0, end_ms: 10000, raw_text: 'original',
  segments: [{ start_ms: 0, end_ms: 10000, text: 'original' }], detected_language: 'kn',
  language_confidence: 0.92, language_source: 'auto', language_uncertain: false, no_speech: false, ...patch
});
export const finalEvent = (seq = 1, patch: Partial<FinalData> = {}, revised = false): PersistedEvent => ({
  type: revised ? 'transcript_revised' : 'transcript_final', seq, session_id: liveId, ts: '2026-11-15T00:00:00Z', data: finalData(patch)
});
export const hello = (last_event_seq = 0) => ({ type: 'hello', session_id: liveId, status: 'active', last_event_seq, server_time: '2026-11-15T00:00:00Z' });
