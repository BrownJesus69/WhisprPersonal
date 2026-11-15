import { AIAPI } from '../lib/ai/api';
import { AI_MESSAGES, aiMessage, unavailableReason, UNAVAILABLE, providerStatus } from '../lib/ai/messages';
import { ServerError, type ServerClient } from '../lib/server/client';
import { aiStatus, briefResult, jobResponse } from './aiFixtures';
const get = jest.fn(), post = jest.fn();
const api = new AIAPI({ get, post } as unknown as ServerClient);
test('typed AI wrappers use fixed authenticated paths', async () => {
  post.mockResolvedValue({ job_id: 'job_one', status: 'queued' });
  const cleanup = { event_id: 'event-1', session_ids: ['s1'], level: 'polished' as const };
  expect(await api.cleanup(cleanup)).toEqual({ job_id: 'job_one', status: 'queued' });
  expect(post).toHaveBeenCalledWith('/api/v1/notes/cleanup', cleanup);
  const brief = { event_id: 'event-1', session_ids: ['s1'], brief_type: 'full' as const, allow_incomplete: false, use_polished: false, notes: [] };
  await api.brief(brief); expect(post).toHaveBeenLastCalledWith('/api/v1/briefs',brief);
  get.mockResolvedValue(aiStatus()); expect(await api.status()).toEqual(aiStatus());
  get.mockResolvedValue(jobResponse({ kind: 'brief', status: 'done', result: briefResult() })); expect((await api.job('job_one')).status).toBe('done');
  get.mockResolvedValue({ session_id: 's1', chunks: [{ sequence: 0, polished_text: null, polished_level: null, polish_error: null }] });
  expect((await api.polished('s1')).chunks).toHaveLength(1);
});
test.each([null, {}, { job_id: '../escape', status: 'queued' }, { job_id: 'id', status: 'invented' }])('submission rejects malformed %#', async value => {
  post.mockResolvedValue(value); await expect(api.cleanup({ event_id: 'e', session_ids: ['s'], level: 'conservative' })).rejects.toMatchObject({ status: 0, code: 'bad_response' });
});
test.each([
  jobResponse({ job_id: 'wrong' }), jobResponse({ status: 'done' }), jobResponse({ kind: 'brief', result: { ...briefResult(), generated_text: 3 } as never }),
  jobResponse({ result: { accepted: -1, rejected: 0, skipped: 0, provider: null, model: null } }),
  jobResponse({ kind: 'brief', result: { ...briefResult(), structured_brief: { X: [3] } } as never }),
  jobResponse({ kind: 'brief', result: { ...briefResult(), source: { session_ids: [], chunk_count: 1, used_polished: false } } }),
  jobResponse({ kind: 'brief', result: { ...briefResult(), generated_text: 'x'.repeat(100001) } }),
])('job rejects malformed %#', async value => { get.mockResolvedValue(value); await expect(api.job('job_one')).rejects.toBeInstanceOf(ServerError); });
test.each([{}, { ...aiStatus(), cloud_available: 1 }, { ...aiStatus(), providers: {} }, { ...aiStatus(), providers: { ...aiStatus().providers, groq: { status: 'invented', model: null, last_error_kind: null } } }])('status rejects malformed %#', async value => {
  get.mockResolvedValue(value); await expect(api.status()).rejects.toMatchObject({ code: 'bad_response' });
});
test.each([{ session_id: 'other', chunks: [] }, { session_id: 's', chunks: [{ sequence: -1 }] }, { session_id: 's', chunks: [{ sequence: 0, polished_text: 'okay', polished_level: 'unknown', polish_error: null }] }])('polished rejects malformed %#', async value => {
  get.mockResolvedValue(value); await expect(api.polished('s')).rejects.toMatchObject({ code: 'bad_response' });
});
test.each(['provider_unavailable','cloud_ai_disabled_for_event','privacy_mode_unknown','transcript_incomplete','transcript_too_long','rate_limited','queue_full','not_found','job_timeout','ai_output_invalid','interrupted','bad_response'])('plain message for %s', code => {
  expect(AI_MESSAGES[code]).toBeTruthy(); expect(aiMessage(code)).toBe(AI_MESSAGES[code]); expect(aiMessage(code)).not.toContain('_');
});
test('availability fails closed and provider statuses have readable names', () => {
  expect(unavailableReason('',aiStatus())).toMatch(/Connect/);
  expect(unavailableReason('url',undefined)).toMatch(/unavailable/);
  expect(unavailableReason('url',aiStatus(),'cloud_ai')).toBe(UNAVAILABLE);
  expect(unavailableReason('url',aiStatus(),'local_only')).toBe('Cloud AI is off for this event');
  expect(unavailableReason('url',aiStatus(true),'cloud_ai')).toBeNull();
  expect(unavailableReason('url',aiStatus(true))).toMatch(/privacy/);
  expect(providerStatus('circuit_open')).toBe('Paused after errors'); expect(providerStatus('auth_failed')).toBe('Key rejected');
});
