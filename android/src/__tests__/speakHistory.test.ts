import { historyGroup } from '@/features/speak/history';
test('groups local calendar dates across month boundaries', () => {
  jest.useFakeTimers(); jest.setSystemTime(new Date(2026, 10, 1, 12));
  expect(historyGroup(new Date(2026,10,1,0,1).toISOString())).toBe('today');
  expect(historyGroup(new Date(2026,9,31,23,59).toISOString())).toBe('yesterday');
  expect(historyGroup(new Date(2026,9,30,23,59).toISOString())).toBe('earlier');
  jest.useRealTimers();
});
