import { normalizeSearch } from '../notes/model';
import type { DisplayRow } from '@/components/TranscriptRow';
export function filterTranscript(rows: DisplayRow[], query: string) {
  const needle = normalizeSearch(query);
  return rows.filter(r => normalizeSearch(r.text).includes(needle));
}
export function sequenceIndex(rows: DisplayRow[], sequence: string | undefined) {
  if (!sequence || !/^\d+$/.test(sequence)) return -1;
  return rows.findIndex(r => r.sequence === Number(sequence));
}
