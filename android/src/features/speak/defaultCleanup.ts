import { repositories } from '@/lib/db/repositories';
import { getEvent } from '@/lib/firebase/events';
import { authedClient } from '@/lib/server/authedClient';
import { AIAPI } from '@/lib/ai/api';
import { aiRuntime } from '@/lib/ai/runtime';
import { unavailableReason } from '@/lib/ai/messages';
import { useSettingsStore, type Settings } from '@/state/settingsStore';

/** Submit once after finalization, using the event's actual privacy rather than a new-event default. */
export async function requestDefaultCleanup(owner: string, id: string, level: Settings['cleanupLevel']): Promise<'original' | 'available' | 'not_configured'> {
  if (level === 'none') return 'original';
  const repo = await repositories(), session = await repo.session(id);
  if (!session || session.owner_uid !== owner || session.status !== 'finalized') return 'original';
  if ((await repo.transcript(id)).some(row => !!row.polished_text)) return 'available';
  // Never automatically resubmit an accepted or failed paid job.
  const existing = (await repo.aiJobs(owner, session.event_id)).find(job => job.kind === 'cleanup' && job.session_ids.includes(id));
  if (existing) {
    if (['failed', 'interrupted'].includes(existing.status)) throw new Error('cleanup_failed');
    return 'available';
  }
  const client = authedClient(owner), runner = aiRuntime.get(owner);
  if (!client || !runner) return 'not_configured';
  const event = await getEvent(session.event_id, owner);
  if (!event || unavailableReason(useSettingsStore.getState().serverUrl, await new AIAPI(client).status(), event.privacyMode)) return 'not_configured';
  await runner.submit({ event_id: session.event_id, session_ids: [id], level });
  return 'available';
}
