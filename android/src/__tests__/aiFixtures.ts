import type { AIJob, AIStatus, BriefDraft, BriefResult, JobResponse } from '../lib/ai/types';
import { session } from './recordingFixtures';
export const aiStatus = (available = false): AIStatus => ({ providers: {
  groq: { status: available ? 'ready' : 'not_configured', model: null, last_error_kind: null },
  sambanova: { status: 'not_configured', model: null, last_error_kind: null },
  local_llm: { status: 'not_configured', model: null, last_error_kind: null },
}, cloud_available: available, local_available: false });
export const briefResult = (): BriefResult => ({ brief_type: 'summary', generated_text: 'Generated text', structured_brief: { Summary: ['One'] },
  brief_warning: null, provider: 'groq', model: 'test model', incomplete: false,
  source: { session_ids: [session().id], chunk_count: 1, used_polished: false } });
export const aiJob = (patch: Partial<AIJob> = {}): AIJob => ({ job_id: 'job_one', kind: 'cleanup', owner_uid: 'owner', event_id: 'event-1',
  session_ids: [session().id], status: 'queued', error_code: null, created_at: session().created_at, updated_at: session().created_at, ...patch });
export const jobResponse = (patch: Partial<JobResponse> = {}): JobResponse => ({ job_id: 'job_one', kind: 'cleanup', status: 'running', provider: null, model: null, error_code: null, result: null, ...patch });
export const draft = (patch: Partial<BriefDraft> = {}): BriefDraft => ({ id: 'brief_device_id', job_id: 'job_one', owner_uid: 'owner', event_id: 'event-1',
  brief_type: 'summary', provider: 'groq', model: 'test model', generated_text: 'Generated text', edited_text: 'Generated text', structured_json: null,
  warning: null, incomplete: 0, session_ids: [session().id], status: 'draft', created_at: session().created_at, updated_at: session().created_at, ...patch });
