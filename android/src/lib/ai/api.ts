import { ServerError, type ServerClient } from '../server/client';
import { BRIEF_TYPES, type AIStatus, type BriefRequest, type BriefResult, type CleanupRequest, type CleanupResult, type JobResponse, type JobStatus, type PolishedChunk } from './types';

type Client = Pick<ServerClient, 'get' | 'post'>;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const nullable = (v: unknown) => v === null || str(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const provider = (v: unknown) => ['groq', 'sambanova', 'local_llm', 'none'].includes(v as string);
const status = (v: unknown): v is JobStatus => ['queued','running','done','failed','interrupted'].includes(v as string);
const ids = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 20 && v.every(x => str(x) && /^[A-Za-z0-9_-]{1,128}$/.test(x));
export const structured = (v: unknown) => v === null || (obj(v) && Object.values(v).every(x => str(x) || (Array.isArray(x) && x.every(str))));
function checked<T>(value: unknown, valid: boolean): T {
  if (!valid) throw new ServerError(0, 'bad_response', 'Unreadable AI response');
  return value as T;
}
export function isCleanupResult(v: unknown): v is CleanupResult {
  return obj(v) && count(v.accepted) && count(v.rejected) && count(v.skipped) && (v.provider === null || provider(v.provider)) && nullable(v.model);
}
export function isBriefResult(v: unknown): v is BriefResult {
  return obj(v) && BRIEF_TYPES.includes(v.brief_type as never) && str(v.generated_text) && v.generated_text.length <= 100000 && structured(v.structured_brief)
    && [null,'unstructured_output'].includes(v.brief_warning as null) && provider(v.provider) && nullable(v.model) && (v.model === null || (v.model as string).length <= 200)
    && typeof v.incomplete === 'boolean' && obj(v.source) && ids(v.source.session_ids) && count(v.source.chunk_count) && typeof v.source.used_polished === 'boolean';
}
export class AIAPI {
  constructor(private client: Client) {}
  private async submit(path: string, request: CleanupRequest | BriefRequest) {
    const v = await this.client.post<unknown>(path, request);
    return checked<{ job_id: string; status: JobStatus }>(v, obj(v) && ids([v.job_id]) && status(v.status));
  }
  cleanup(request: CleanupRequest) { return this.submit('/api/v1/notes/cleanup', request); }
  brief(request: BriefRequest) { return this.submit('/api/v1/briefs', request); }
  async job(id: string): Promise<JobResponse> {
    const v = await this.client.get<unknown>(`/api/v1/ai/jobs/${encodeURIComponent(id)}`);
    return checked(v, obj(v) && v.job_id === id && ['cleanup','brief'].includes(v.kind as string) && status(v.status)
      && (v.provider === null || provider(v.provider)) && nullable(v.model) && nullable(v.error_code)
      && (v.result === null ? v.status !== 'done' : v.kind === 'cleanup' ? isCleanupResult(v.result) : isBriefResult(v.result)));
  }
  async polished(id: string): Promise<{ session_id: string; chunks: PolishedChunk[] }> {
    const v = await this.client.get<unknown>(`/api/v1/sessions/${encodeURIComponent(id)}/polished`);
    return checked(v, obj(v) && v.session_id === id && Array.isArray(v.chunks) && v.chunks.every(c => obj(c) && count(c.sequence) && nullable(c.polished_text) && [null,'conservative','polished'].includes(c.polished_level as null) && nullable(c.polish_error)));
  }
  async status(): Promise<AIStatus> {
    const v = await this.client.get<unknown>('/api/v1/ai/status');
    return checked(v, obj(v) && typeof v.cloud_available === 'boolean' && typeof v.local_available === 'boolean' && obj(v.providers)
      && ['groq','sambanova','local_llm'].every(key => {
        const p = (v.providers as Record<string, unknown>)[key];
        return obj(p) && ['not_configured','ready','degraded','circuit_open','auth_failed'].includes(p.status as string) && nullable(p.model) && nullable(p.last_error_kind);
      }));
  }
}
