import type { Repositories } from '../db/repositories';
import { ServerError, type ServerClient } from '../server/client';
export const BUSY_MESSAGE = 'The laptop is still transcribing a part; try again in a moment';
export class LaptopUnavailable extends Error {
  constructor() { super('The laptop is unreachable. You can delete on this phone only; the laptop copy remains until deletion retries when connected.'); }
}
export async function deleteSession(d: {
  repo: Repositories; client: Pick<ServerClient,'delete'> | null; owner: string; id: string;
  activeId: string | null; phase: string; removeOrphans?: (id: string) => void | Promise<void>; phoneOnly?: boolean; removeFile: (uri: string) => void | Promise<void>;
}) {
  const s = await d.repo.session(d.id);
  if (!s || s.owner_uid !== d.owner) throw new Error('Session unavailable');
  if (['recording','paused'].includes(s.status) || (d.activeId === d.id && ['recording','paused','stopping','requesting_permission','error'].includes(d.phase))) throw new Error('Stop this recording before deleting it.');
  let pending = false;
  if (s.server_created) {
    try {
      if (!d.client) throw new LaptopUnavailable();
      await d.client.delete(`/api/v1/sessions/${encodeURIComponent(d.id)}`);
    } catch (e) {
      if (e instanceof ServerError && e.status === 409) throw new Error(BUSY_MESSAGE);
      if (!(e instanceof ServerError && e.status === 404)) {
        if (!(e instanceof LaptopUnavailable) && !(e instanceof ServerError && ['network_unreachable','timeout'].includes(e.code))) throw e;
        if (!d.phoneOnly) throw new LaptopUnavailable();
        pending = true;
      }
    }
  }
  for (const c of await d.repo.chunks(d.id)) if (!c.local_deleted) await d.removeFile(c.uri);
  if (s.master_uri) await d.removeFile(s.master_uri);
  await d.removeOrphans?.(d.id);
  await d.repo.deleteSessionRows(d.id,d.owner,pending);
}
export async function retryServerDeletes(repo: Repositories, client: Pick<ServerClient,'delete'>, owner: string) {
  for (const d of await repo.pendingServerDeletes(owner)) {
    try { await client.delete(`/api/v1/sessions/${encodeURIComponent(d.session_id)}`); }
    catch (e) { if (!(e instanceof ServerError && e.status === 404)) continue; }
    await repo.clearServerDelete(d.session_id,owner);
  }
}
