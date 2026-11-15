import { TranslationAPI } from '../lib/translation/api';
import type { ServerClient } from '../lib/server/client';
import { translation, translationStatus } from './translationFixtures';
import { session } from './recordingFixtures';
const request = { event_id: 'event-1', session_ids: [session().id], target_lang: 'en' as const, polish: false };
function setup(value: unknown) {
  const get = jest.fn(async () => value), post = jest.fn(async () => value);
  return { api: new TranslationAPI({ get, post } as unknown as ServerClient), get, post };
}
test('validates submissions and uses translation endpoints', async () => {
  const t = setup({ job_id: 'job_1', status: 'queued' });
  expect(await t.api.submit(request)).toEqual({ job_id: 'job_1', status: 'queued' });
  expect(t.post).toHaveBeenCalledWith('/api/v1/translate',request);
  await expect(t.api.submit({ ...request, session_ids: [] })).rejects.toMatchObject({ code: 'validation_error' });
  expect(t.post).toHaveBeenCalledTimes(1);
  expect(await setup(translationStatus()).api.status()).toEqual(translationStatus());
});
test.each([
  { job_id: 'job_1', status: 'done' }, { job_id: '../x', status: 'queued' }, { job_id: 'x', status: 'strange' },
])('rejects malformed submission %j', async value => { await expect(setup(value).api.submit(request)).rejects.toMatchObject({ code: 'bad_response' }); });
test.each([
  { sequence: -1 }, { engine: 'google' }, { source_lang: 'private/url' }, { model: null }, { text: 2 },
  { created_at: 'invalid' }, { polish_provider: 'unknown' }, { polished_text: 'Unlabelled' }, { error_code: {} },
])('rejects invalid translation %j', async patch => {
  const t = setup({ session_id: session().id, target_lang: 'en', chunks: [{ ...translation(),...patch }] });
  await expect(t.api.translations(session().id,'en')).rejects.toMatchObject({ code: 'bad_response' });
});
test('validates identity, duplicate sequences and terminal job results', async () => {
  const t = setup({ session_id: session().id, target_lang: 'en', chunks: [translation()] });
  expect(await t.api.translations(session().id,'en')).toEqual([translation()]);
  expect(t.get).toHaveBeenCalledWith(`/api/v1/sessions/${session().id}/translations?target_lang=en`);
  for (const value of [
    { session_id: 'other', target_lang: 'en', chunks: [] },
    { session_id: session().id, target_lang: 'ta', chunks: [] },
    { session_id: session().id, target_lang: 'en', chunks: [translation(),translation()] },
  ]) await expect(setup(value).api.translations(session().id,'en')).rejects.toMatchObject({ code: 'bad_response' });
  const done = { job_id: 'one', status: 'done', error_code: null, result: { translated: 1, skipped: 0, failed: 0 } };
  expect(await setup(done).api.job('one')).toEqual(done);
  for (const patch of [{ job_id: 'wrong' },{ result: null },{ result: { translated: -1, skipped: 0, failed: 0 } }]) await expect(setup({ ...done,...patch }).api.job('one')).rejects.toMatchObject({ code: 'bad_response' });
});
test('status rejects arbitrary words and pairs', async () => {
  for (const value of [null, { ...translationStatus(), indictrans2: { indic_en: 'SECRET' } }, { ...translationStatus(), libretranslate: { 'xx-yy': { enabled: true, eligible: true, available: true } } }]) await expect(setup(value).api.status()).rejects.toMatchObject({ code: 'bad_response' });
});
test('accepts nullable provenance for failed/skipped rows from the 10a contract', async () => {
  const row = translation({ text: null, engine: null, model: null, error_code: 'source_unknown' });
  expect(await setup({ session_id: session().id, target_lang: 'en', chunks: [row] }).api.translations(session().id,'en')).toEqual([row]);
});
test('strips unknown response keys before passing rows to SQLite', async () => {
  const row = { ...translation(), unsafe_column: 'extra data' };
  expect(await setup({ session_id: session().id, target_lang: 'en', chunks: [row] }).api.translations(session().id,'en')).toEqual([translation()]);
});
