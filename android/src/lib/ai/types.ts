export const BRIEF_TYPES = ['summary', 'action_items', 'decisions', 'follow_ups', 'full'] as const;
export type BriefType = typeof BRIEF_TYPES[number];
export type Provider = 'groq' | 'sambanova' | 'local_llm' | 'none';
export type ProviderStatus = 'not_configured' | 'ready' | 'degraded' | 'circuit_open' | 'auth_failed';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
export type JobKind = 'cleanup' | 'brief';
export type StructuredBrief = Record<string, string[] | string>;
export interface AIStatus {
  providers: Record<Exclude<Provider, 'none'>, { status: ProviderStatus; model: string | null; last_error_kind: string | null }>;
  cloud_available: boolean; local_available: boolean;
}
export interface CleanupRequest { event_id: string; session_ids: string[]; level: 'conservative' | 'polished' }
export interface BriefRequest {
  event_id: string; session_ids: string[]; brief_type: BriefType; allow_incomplete: boolean; use_polished: boolean;
  notes: { text: string; timestamp_ms: number | null; speaker: string | null }[];
}
export interface CleanupResult { accepted: number; rejected: number; skipped: number; provider: Provider | null; model: string | null }
export interface BriefResult {
  brief_type: BriefType; generated_text: string; structured_brief: StructuredBrief | null;
  brief_warning: 'unstructured_output' | null; provider: Provider; model: string | null; incomplete: boolean;
  source: { session_ids: string[]; chunk_count: number; used_polished: boolean };
}
export interface JobResponse {
  job_id: string; kind: JobKind; status: JobStatus; provider: Provider | null; model: string | null;
  error_code: string | null; result: CleanupResult | BriefResult | null;
}
export interface PolishedChunk { sequence: number; polished_text: string | null; polished_level: 'conservative' | 'polished' | null; polish_error: string | null }
export interface AIJob {
  job_id: string; owner_uid: string; event_id: string; kind: JobKind; session_ids: string[];
  status: JobStatus; error_code: string | null; created_at: string; updated_at: string;
}
export interface BriefDraft {
  id: string; owner_uid: string; event_id: string; job_id: string | null; brief_type: BriefType;
  provider: Provider | null; model: string | null; generated_text: string; edited_text: string;
  structured_json: string | null; warning: string | null; incomplete: number; session_ids: string[];
  status: 'draft' | 'saved'; created_at: string; updated_at: string;
}
export const terminal = (status: JobStatus) => ['done', 'failed', 'interrupted'].includes(status);
