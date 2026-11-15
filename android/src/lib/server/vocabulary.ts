import type { ServerClient } from './client';
export function validateTerms(terms: string[]) {
  const values = [...new Set(terms.map(t => t.trim()).filter(Boolean))];
  if (values.length > 200 || values.some(t => [...t].length > 64)) throw new Error('Use at most 200 terms, each 64 characters or fewer.');
  return values;
}
export class VocabularyAPI {
  constructor(private client: Pick<ServerClient,'get'|'post'> | null) {}
  load(eventId: string) {
    if (!this.client) throw new Error('Connect to the laptop to load vocabulary.');
    return this.client.get<{ terms: string[] }>(`/api/v1/vocabulary?event_id=${encodeURIComponent(eventId)}`);
  }
  save(eventId: string, terms: string[]) {
    if (!this.client) throw new Error('Connect to the laptop to save vocabulary.');
    return this.client.post('/api/v1/vocabulary',{ event_id: eventId, terms: validateTerms(terms), replacements: [] });
  }
}
