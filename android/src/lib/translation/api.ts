import { ServerError, type ServerClient } from '../server/client';
import { DIRECTIONS, ENGINE_STATES, ENGINES, TARGETS, type Target, type TranslateRequest, type Translation, type TranslationJobResponse, type TranslationStatus } from './types';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const nullable = (v: unknown) => v === null || (str(v) && v.length <= 200);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const date = (v: unknown) => str(v) && Number.isFinite(Date.parse(v));
const status = (v: unknown) => ['queued','running','done','failed','interrupted'].includes(v as string);
const id = (v: unknown) => str(v) && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function checked<T>(v: unknown, valid: boolean): T {
  if (!valid) throw new ServerError(0, 'bad_response', 'Unreadable translation response');
  return v as T;
}
export function isTranslationStatus(v: unknown): v is TranslationStatus {
  return obj(v) && obj(v.indictrans2) && DIRECTIONS.every(d => ENGINE_STATES.includes((v.indictrans2 as Record<string, unknown>)[d] as never))
    && obj(v.groq_audio) && typeof v.groq_audio.configured === 'boolean' && obj(v.libretranslate)
    && Object.entries(v.libretranslate).every(([pair, p]) => /^(en|kn|ta|hi)-(en|kn|ta|hi)$/.test(pair) && pair.split('-')[0] !== pair.split('-')[1] && obj(p) && ['enabled','eligible','available'].every(k => typeof p[k] === 'boolean'));
}
function chunk(v: unknown): boolean {
  return obj(v) && count(v.sequence) && str(v.source_lang) && /^[a-z]{2,3}$/.test(v.source_lang)
    && (v.text === null || (str(v.text) && v.text.length <= 100000)) && (v.engine === null || ENGINES.includes(v.engine as never)) && nullable(v.model)
    && (str(v.error_code) || (str(v.text) && ENGINES.includes(v.engine as never) && str(v.model) && v.model.length > 0))
    && date(v.created_at) && (v.polished_text === null || (str(v.polished_text) && v.polished_text.length <= 100000))
    && [null,'groq','sambanova','local_llm'].includes(v.polish_provider as never) && nullable(v.polish_model)
    && (v.polished_at === null || date(v.polished_at)) && nullable(v.error_code)
    && (v.polished_text === null || (v.polish_provider !== null && str(v.polish_model) && date(v.polished_at)));
}
export class TranslationAPI {
  constructor(private client: Pick<ServerClient, 'get' | 'post'>) {}
  async submit(request: TranslateRequest) {
    if (!id(request.event_id) || !Array.isArray(request.session_ids) || !request.session_ids.length || request.session_ids.length > 20 || !request.session_ids.every(id) || !TARGETS.includes(request.target_lang) || typeof request.polish !== 'boolean') throw new ServerError(0,'validation_error','Choose finalized sessions and a target language');
    const v = await this.client.post<unknown>('/api/v1/translate', request);
    return checked<{ job_id: string; status: 'queued' | 'running' }>(v, obj(v) && id(v.job_id) && ['queued','running'].includes(v.status as string));
  }
  async job(jobId: string): Promise<TranslationJobResponse> {
    const v = await this.client.get<unknown>(`/api/v1/translation/jobs/${encodeURIComponent(jobId)}`);
    return checked(v, obj(v) && v.job_id === jobId && status(v.status) && nullable(v.error_code)
      && (v.result === null ? v.status !== 'done' : obj(v.result) && ['translated','skipped','failed'].every(k => count((v.result as Record<string,unknown>)[k]))));
  }
  async translations(sessionId: string, target: Target): Promise<Translation[]> {
    const v = await this.client.get<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/translations?target_lang=${target}`);
    const r = checked<{ chunks: Omit<Translation,'session_id'|'target_lang'>[] }>(v, obj(v) && v.session_id === sessionId && v.target_lang === target && Array.isArray(v.chunks) && v.chunks.every(chunk)
      && new Set((v.chunks as {sequence: number}[]).map(c => c.sequence)).size === (v.chunks as unknown[]).length);
    // Project known columns; never pass arbitrary response keys to SQLite identifiers.
    return r.chunks.map(c => ({ session_id: sessionId, target_lang: target,
      sequence: c.sequence, source_lang: c.source_lang, text: c.text, engine: c.engine,
      model: c.model, created_at: c.created_at, polished_text: c.polished_text,
      polish_provider: c.polish_provider, polish_model: c.polish_model,
      polished_at: c.polished_at, error_code: c.error_code }));
  }
  async status(): Promise<TranslationStatus> {
    const v = await this.client.get<unknown>('/api/v1/translation/status');
    return checked(v, isTranslationStatus(v));
  }
}
