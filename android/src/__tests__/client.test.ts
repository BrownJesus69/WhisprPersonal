import { ServerClient } from '@/lib/server/client';
import { response, mockFetch } from './helpers';

function setup() {
  const onAuthExpired = jest.fn(async () => {
  });
  const client = new ServerClient({
    baseUrl: 'http://192.168.1.20:8000',
    getServerKey: async () => 'test-server-key',
    getBearer: async () => 'test-bearer',
    onAuthExpired
  });
  return { client, onAuthExpired };
}

test('success and protected headers', async () => {
  const { client } = setup();
  mockFetch().mockResolvedValue(response({ ok: true }));
  await expect(client.get('/api/v1/auth/check')).resolves.toEqual({ ok: true });
  expect(mockFetch()).toHaveBeenCalledWith('http://192.168.1.20:8000/api/v1/auth/check', expect.objectContaining({ headers: expect.objectContaining({ 'X-WhisprPersonal-Server-Key': 'test-server-key', Authorization: 'Bearer test-bearer' }) }));
});

test('public health has no credentials', async () => {
  mockFetch().mockResolvedValue(response({ status: 'ok' }));
  await setup().client.get('/health', { auth: false });
  expect(mockFetch().mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
});

test('parses error envelope without reflecting secret-like message', async () => {
  mockFetch().mockResolvedValue(response({ error: { code: 'invalid_server_key', message: 'test-bearer test-server-key', request_id: 'request-1' } }, 403));
  const error = await setup().client.get('/check').catch(e => e);
  expect(error).toMatchObject({ status: 403, code: 'invalid_server_key', requestId: 'request-1' });
  expect(String(error)).not.toMatch(/test-bearer|test-server-key/);
  expect(error).toHaveProperty('message', '[redacted] [redacted]');
});

test('network failure is safe', async () => {
  mockFetch().mockRejectedValue(new Error('private request detail'));
  await expect(setup().client.get('/health', { auth: false })).rejects.toMatchObject({ status: 0, code: 'network_unreachable' });
});

test('timeout aborts fetch', async () => {
  jest.useFakeTimers();
  mockFetch().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
  }));
  const pending = setup().client.get('/health', { auth: false, timeoutMs: 10 });
  const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await jest.advanceTimersByTimeAsync(11);
  await assertion;
  jest.useRealTimers();
});

test('429 exposes Retry-After and never automatically retries', async () => {
  mockFetch().mockResolvedValue(response({ error: { code: 'rate_limited', message: 'wait', request_id: 'r' } }, 429, '30'));
  await expect(setup().client.get('/check')).rejects.toMatchObject({ status: 429, retryAfterS: 30 });
  expect(mockFetch()).toHaveBeenCalledTimes(1);
});

test('refreshes once then retries successfully', async () => {
  const { client, onAuthExpired } = setup();
  mockFetch().mockResolvedValueOnce(response({ error: { code: 'auth_token_expired' } }, 401)).mockResolvedValueOnce(response({ ok: true }));
  await expect(client.get('/check')).resolves.toEqual({ ok: true });
  expect(onAuthExpired).toHaveBeenCalledTimes(1);
  expect(mockFetch()).toHaveBeenCalledTimes(2);
});

test('never retries twice', async () => {
  const { client, onAuthExpired } = setup();
  mockFetch().mockResolvedValue(response({ error: { code: 'auth_token_expired' } }, 401));
  await expect(client.get('/check')).rejects.toMatchObject({ code: 'auth_token_expired' });
  expect(onAuthExpired).toHaveBeenCalledTimes(1);
  expect(mockFetch()).toHaveBeenCalledTimes(2);
});

test('POST body and missing key fail closed', async () => {
  mockFetch().mockResolvedValue(response({}));
  await setup().client.post('/revoke', { grant_id: 'g' });
  expect(mockFetch().mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"grant_id":"g"}' });
  const client = new ServerClient({
    baseUrl: 'http://localhost',
    getServerKey: async () => null,
    getBearer: async () => '',
    onAuthExpired: async () => {
    }
  });
  await expect(client.get('/check')).rejects.toMatchObject({ code: 'missing_server_key' });
});
