import { DIRECTIONS, ENGINE_STATES } from '../translation/types';
import type { Repositories } from '../db/repositories';
export type DiagnosticRow = { label: string; value: string };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
export function laptopDiagnostics(data: unknown): DiagnosticRow[] {
  const root = object(data), rows: DiagnosticRow[] = [];
  const add = (label: string, value: unknown) => { if (['string','boolean','number'].includes(typeof value)) rows.push({ label, value: String(value) }); };
  for (const key of ['status','version','average_real_time_factor']) add(key,root[key]);
  const groups: Record<string,string[]> = {
    model: ['name','status','device','device_resolved','compute_type'], gpu: ['available','name','vram_total_mb','detection'],
    queue: ['status','depth','max_depth','workers'], chunk_counts: ['queued','processing','done','failed'],
    limits: ['max_chunk_upload_bytes','max_chunk_duration_s','max_overlap_ms','rate_limit_global_per_minute','rate_limit_per_ip_per_minute','rate_limit_per_user_per_minute','max_json_body_bytes'],
  };
  for (const [group, keys] of Object.entries(groups)) for (const key of keys) add(`${group}.${key}`,object(root[group])[key]);
  for (const provider of ['groq','sambanova','local_llm']) for (const key of ['configured','status','model']) add(`${provider}.${key}`,object(object(root.providers)[provider])[key]);
  rows.push(...translationDiagnostics(root.translation));
  return rows;
}
export function serverHost(url: string) {
  try { return new URL(url.includes('://') ? url : `http://${url}`).hostname; } catch { return 'Not set'; }
}
export async function phoneDiagnostics(repo: Repositories, owner: string, info: {
  version: string; versionCode: number | undefined; serverUrl: string; passExpiry: number | null;
  network: string; available: number; total: number; now?: number;
}): Promise<DiagnosticRow[]> {
  const sessions = await repo.sessions(owner);
  const chunks = (await Promise.all(sessions.map(s => repo.chunks(s.id)))).flat();
  const eventIds = await repo.noteEventIds(owner);
  const states = (await Promise.all(eventIds.map(id => repo.noteStates(owner,id)))).flat();
  const rows: DiagnosticRow[] = [
    { label: 'App version', value: info.version }, { label: 'Version code', value: String(info.versionCode ?? 'Unknown') },
    { label: 'Sign-in mode', value: info.passExpiry && info.passExpiry * 1000 > (info.now ?? Date.now()) ? `Offline pass until ${new Date(info.passExpiry * 1000).toISOString()}` : 'Firebase' },
    { label: 'Server host', value: serverHost(info.serverUrl) }, { label: 'Network', value: info.network },
    { label: 'Free disk bytes', value: String(info.available) }, { label: 'Total disk bytes', value: String(info.total) },
  ];
  for (const status of ['recording','paused','stopped','interrupted','finalizing','finalized','failed']) rows.push({ label: `Sessions ${status}`, value: String(sessions.filter(s => s.status === status).length) });
  for (const status of ['pending','failed_permanent']) rows.push({ label: `Chunks ${status}`, value: String(chunks.filter(c => c.status === status).length) });
  for (const status of ['pending','conflict','failed']) rows.push({ label: `Notes ${status}`, value: String(states.filter(s => s === status).length) });
  rows.push({ label: 'AI jobs running', value: String((await repo.aiJobs(owner)).filter(j => ['queued','running'].includes(j.status)).length) },
    { label: 'Pending server deletes', value: String((await repo.pendingServerDeletes(owner)).length) });
  const error = chunks.filter(c => c.last_error).sort((a,b) => b.updated_at.localeCompare(a.updated_at))[0]?.last_error;
  // Never copy reflected messages or arbitrary remote error codes into a diagnostics share.
  const codes = ['network_unreachable','timeout','queue_full','auth_token_expired','renew_required','auth_unavailable','upload_unavailable','chunk_conflict','payload_too_large','unsupported_media_type','validation_error'];
  rows.push({ label: 'Last upload error code', value: !error ? 'None' : codes.includes(error) ? error : 'other_error' });
  return rows;
}
export function diagnosticsText(phone: DiagnosticRow[], laptop: DiagnosticRow[]) {
  return ['WhisprPersonal diagnostics','Phone',...phone.map(r => `${r.label}: ${r.value}`),'','Laptop',...(laptop.length ? laptop.map(r => `${r.label}: ${r.value}`) : ['Unavailable; connect to laptop'])].join('\n');
}

export function translationDiagnostics(data: unknown): DiagnosticRow[] {
  const root = object(data), indic = object(root.indictrans2), libre = object(root.libretranslate);
  const rows = DIRECTIONS.map(d => ({ label: `IndicTrans2 ${d}`, value: ENGINE_STATES.includes(indic[d] as never) ? String(indic[d]) : 'unavailable' }));
  for (const source of ['kn','ta','hi','en']) for (const target of ['kn','ta','hi','en']) {
    if (source === target) continue;
    const pair = `${source}-${target}`, p = object(libre[pair]);
    if (typeof p.enabled !== 'boolean') continue;
    rows.push({ label: `LibreTranslate ${pair}`, value: `${p.enabled === true ? 'enabled' : 'disabled'} \u00b7 ${p.eligible === true ? 'eligible' : 'ineligible'} \u00b7 ${p.available === true ? 'available' : 'unavailable'}` });
  }
  rows.push({ label: 'Groq audio translation', value: object(root.groq_audio).configured === true ? 'configured' : 'not_configured' });
  return rows;
}
