export function response(body: unknown, status = 200, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (key: string) => key === 'Retry-After' ? retryAfter ?? null : null }
  } as Response;
}

export function mockFetch() {
  return jest.mocked(global.fetch);
}
