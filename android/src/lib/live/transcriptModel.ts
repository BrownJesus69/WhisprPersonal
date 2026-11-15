import type { FinalData, LanguageMode, PartialEvent, PersistedEvent, Segment } from './events.ts';

export interface Row extends FinalData { revision: number }
export interface Timeline { language: string; fromSequence: number; toSequence: number }
export interface TranscriptState {
  finals: Map<number, Row>; partials: Map<number, Segment[]>; failed: Map<number, string>;
  language: { mode: LanguageMode; locked?: string; current?: string; confidence?: number; uncertain: boolean; timeline: Timeline[] };
  finalized?: { transcriptStatus: string; missing: number[]; failed: number[] };
  lastSeq: number;
}
export function initialTranscript(): TranscriptState {
  return { finals: new Map(), partials: new Map(), failed: new Map(), language: { mode: 'auto', uncertain: false, timeline: [] }, lastSeq: 0 };
}
export function withFinal(state: TranscriptState, data: FinalData, revision?: number): TranscriptState {
  const finals = new Map(state.finals), partials = new Map(state.partials), failed = new Map(state.failed);
  const previous = finals.get(data.sequence);
  finals.set(data.sequence, { ...data, revision: revision ?? (previous ? previous.revision + Number(previous.raw_text !== data.raw_text) : 0) });
  const sorted = new Map([...finals].sort(([a], [b]) => a - b));
  partials.delete(data.sequence); failed.delete(data.sequence);
  const timeline: Timeline[] = [];
  let latest: Row | undefined;
  for (const row of sorted.values()) {
    if (row.no_speech || !row.detected_language) continue;
    latest = row;
    const last = timeline[timeline.length - 1];
    if (last?.language === row.detected_language) last.toSequence = row.sequence;
    else timeline.push({ language: row.detected_language, fromSequence: row.sequence, toSequence: row.sequence });
  }
  return { ...state, finals: sorted, partials, failed, language: { ...state.language, timeline,
    current: latest?.detected_language ?? undefined, confidence: latest?.language_confidence ?? undefined, uncertain: latest?.language_uncertain ?? false } };
}
export function apply(state: TranscriptState, event: PersistedEvent | PartialEvent): TranscriptState {
  if ('seq' in event && event.seq <= state.lastSeq) return state;
  let next = { ...state, lastSeq: 'seq' in event ? event.seq : state.lastSeq };
  switch (event.type) {
    case 'transcript_final': case 'transcript_revised': return withFinal(next, event.data);
    case 'transcript_partial': {
      if (state.finals.has(event.sequence)) return state;
      const partials = new Map(state.partials); partials.set(event.sequence, [event.data]);
      return { ...next, partials };
    }
    case 'chunk_failed': {
      const failed = new Map(state.failed); failed.set(event.data.sequence, event.data.error_code);
      const partials = new Map(state.partials); partials.delete(event.data.sequence);
      return { ...next, failed, partials };
    }
    case 'language_locked': next = { ...next, language: { ...state.language, locked: event.data.language, confidence: event.data.confidence } }; break;
    case 'language_changed': next = { ...next, language: { ...state.language, locked: event.data.to } }; break;
    case 'language_override': next = { ...next, language: { ...state.language, mode: event.data.language, locked: undefined } }; break;
    case 'session_finalized': next = { ...next, partials: new Map(), finalized: { transcriptStatus: event.data.transcript_status, missing: event.data.missing_sequences, failed: event.data.failed_sequences } }; break;
  }
  return next;
}
