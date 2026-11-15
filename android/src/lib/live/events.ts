export type LanguageMode = 'auto' | 'kn' | 'ta' | 'hi' | 'en';
export const isMode = (v: unknown): v is LanguageMode => ['auto', 'kn', 'ta', 'hi', 'en'].includes(v as string);
export interface Segment { start_ms: number; end_ms: number; text: string }
export interface FinalData {
  chunk_id: string; sequence: number; start_ms: number; end_ms: number; raw_text: string;
  segments: Segment[]; detected_language: string | null; language_confidence: number | null;
  language_source: 'auto' | 'locked' | 'override'; language_uncertain: boolean; no_speech: boolean;
}
interface Payloads {
  session_created: { event_id: string };
  chunk_queued: { chunk_id: string; sequence: number };
  chunk_processing: { chunk_id: string; sequence: number };
  transcript_final: FinalData;
  transcript_revised: FinalData;
  chunk_failed: { chunk_id: string; sequence: number; error_code: string };
  language_locked: { language: string; confidence: number; at_sequence: number };
  language_changed: { from: string | null; to: string; at_sequence: number };
  language_override: { language: LanguageMode; by: string };
  session_finalizing: Record<string, never>;
  session_finalized: { transcript_status: string; missing_sequences: number[]; failed_sequences: number[] };
  session_deleted: Record<string, never>;
}
export type PersistedEvent = { [K in keyof Payloads]: { type: K; seq: number; session_id: string; ts: string; data: Payloads[K] } }[keyof Payloads];
export interface PartialEvent { type: 'transcript_partial'; session_id: string; chunk_id: string; sequence: number; data: Segment }
export type StreamEvent = PersistedEvent | PartialEvent |
  { type: 'hello'; session_id: string; status: string; last_event_seq: number; server_time: string } |
  { type: 'ping' } | { type: 'error'; code: string; message?: string };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const int = (v: unknown): v is number => num(v) && Number.isSafeInteger(v);
const confidence = (v: unknown) => num(v) && v <= 1;
const language = (v: unknown) => str(v) && /^[a-z]{2,3}$/.test(v);
const code = (v: unknown) => str(v) && /^[a-z][a-z0-9_]{0,100}$/.test(v);
const segment = (v: unknown): v is Segment => object(v) && num(v.start_ms) && num(v.end_ms) && v.end_ms >= v.start_ms && str(v.text);
export function isFinalData(v: unknown): v is FinalData {
  return object(v) && str(v.chunk_id) && int(v.sequence) && num(v.start_ms) && num(v.end_ms) && v.end_ms >= v.start_ms &&
    str(v.raw_text) && Array.isArray(v.segments) && v.segments.every(segment) &&
    (v.detected_language === null || language(v.detected_language)) &&
    (v.language_confidence === null || confidence(v.language_confidence)) &&
    ['auto', 'locked', 'override'].includes(v.language_source as string) &&
    typeof v.language_uncertain === 'boolean' && typeof v.no_speech === 'boolean';
}
/** Never return unvalidated payloads to reducers/persistence. No reflected text in logs. */
export function parseEvent(input: unknown): StreamEvent | null {
  let v: unknown = input;
  if (str(input)) { try { v = JSON.parse(input); } catch { return null; } }
  if (!object(v)) return null;
  if (v.type === 'ping') return { type: 'ping' };
  if (v.type === 'error') return code(v.code) ? { type: 'error', code: v.code as string } : null;
  if (!str(v.session_id)) return null;
  if (v.type === 'hello') return str(v.status) && int(v.last_event_seq) && str(v.server_time) ? v as unknown as StreamEvent : null;
  if (v.type === 'transcript_partial') return str(v.chunk_id) && int(v.sequence) && segment(v.data) ? v as unknown as PartialEvent : null;
  if (!int(v.seq) || v.seq === 0 || !str(v.ts) || !object(v.data)) return null;
  const d = v.data;
  let valid = false;
  switch (v.type) {
    case 'session_created': valid = str(d.event_id); break;
    case 'chunk_queued': case 'chunk_processing': valid = str(d.chunk_id) && int(d.sequence); break;
    case 'transcript_final': case 'transcript_revised': valid = isFinalData(d); break;
    case 'chunk_failed': valid = str(d.chunk_id) && int(d.sequence) && code(d.error_code); break;
    case 'language_locked': valid = language(d.language) && confidence(d.confidence) && int(d.at_sequence); break;
    case 'language_changed': valid = (d.from === null || language(d.from)) && language(d.to) && int(d.at_sequence); break;
    case 'language_override': valid = isMode(d.language) && str(d.by); break;
    case 'session_finalizing': case 'session_deleted': valid = true; break;
    case 'session_finalized': valid = str(d.transcript_status) && Array.isArray(d.missing_sequences) && d.missing_sequences.every(int) && Array.isArray(d.failed_sequences) && d.failed_sequences.every(int); break;
  }
  return valid ? v as unknown as PersistedEvent : null;
}
