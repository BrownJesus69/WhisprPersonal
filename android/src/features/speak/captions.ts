import type { ConnectionStatus } from '@/state/connectionStore';
import type { Health } from '@/lib/server/types';
import type { LiveStatus } from '@/lib/live/streamClient';
export function captionsAvailable(connection: ConnectionStatus, health: Health | null, live: LiveStatus): boolean {
  // Health exposes model readiness, not a streaming flag. Require an observed live stream.
  return ['connected', 'verified'].includes(connection) && health?.model.status === 'ready' && live === 'live';
}
export function followsLatest(offset: number, contentHeight: number, viewportHeight: number): boolean {
  return contentHeight - offset - viewportHeight <= 80;
}
