import { VocabularyAPI, validateTerms } from '../lib/server/vocabulary';
import type { ServerClient } from '../lib/server/client';
test('load query and save exact contract; replacements reserved', async () => {
  const client = { get: jest.fn(async () => ({ terms: ['Name'] })),post: jest.fn(async () => ({})) };
  const api = new VocabularyAPI(client as unknown as Pick<ServerClient,'get'|'post'>);
  expect(await api.load('event-1')).toEqual({ terms: ['Name'] }); expect(client.get).toHaveBeenCalledWith('/api/v1/vocabulary?event_id=event-1');
  await api.save('event-1',[' Name ','Place','Name']); expect(client.post).toHaveBeenCalledWith('/api/v1/vocabulary',{ event_id: 'event-1',terms: ['Name','Place'],replacements: [] });
});
test('validates term length and max count', () => {
  expect(() => validateTerms(['x'.repeat(65)])).toThrow('64 characters'); expect(() => validateTerms(Array.from({ length: 201 },(_,i) => String(i)))).toThrow('200 terms'); expect(validateTerms(['',' Name ','Name'])).toEqual(['Name']);
});
test('offline load/save explain laptop requirement', () => {
  expect(() => new VocabularyAPI(null).load('e')).toThrow('Connect to the laptop'); expect(() => new VocabularyAPI(null).save('e',[])).toThrow('Connect to the laptop');
});
