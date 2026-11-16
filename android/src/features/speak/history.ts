import type { LocalSession } from '@/lib/db/repositories';
export function historyGroup(date: string, now = new Date()): 'today' | 'yesterday' | 'earlier' {
  const value = new Date(date).toDateString();
  if (value === now.toDateString()) return 'today';
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  return value === yesterday.toDateString() ? 'yesterday' : 'earlier';
}
export function duration(session: LocalSession): string {
  const seconds = Math.floor(session.time_ms / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}
