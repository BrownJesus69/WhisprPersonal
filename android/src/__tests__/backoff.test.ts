import { backoff } from '@/lib/upload/backoff';
test('full jitter bounds, monotone envelope and five-minute exponential cap', () => {
  let previous = 0;
  for (let n = 1; n < 100; n++) {
    const max = backoff(n, undefined, () => 1);
    expect(max).toBeGreaterThanOrEqual(previous); expect(max).toBeLessThanOrEqual(300000);
    expect(backoff(n, undefined, () => 0)).toBe(0);
    expect(backoff(n, undefined, () => 0.5)).toBe(Math.floor(max / 2)); previous = max;
  }
});
test('Retry-After takes precedence even over the jitter cap', () => {
  expect(backoff(50, 600, () => 0)).toBe(600000);
  expect(backoff(1, 20)).toBe(20000); expect(backoff(1, 0)).toBe(0);
});
