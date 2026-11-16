import type { AIJob } from '@/lib/ai/types';
import type { LocalSession, TranscriptRow } from '@/lib/db/repositories';
export function recognitionProblem(session: LocalSession | null, rows: TranscriptRow[]): 'recognitionFailed' | 'noSpeech' | null {
  if (!session) return null;
  if (session.status === 'failed' || rows.some(row => !!row.failed_code)) return 'recognitionFailed';
  if (session.status === 'finalized' && rows.every(row => row.no_speech || !row.raw_text.trim())) return 'noSpeech';
  return null;
}

export function cleanupFailedFor(jobs: AIJob[], id: string): boolean {
  const latest = jobs.filter(job => job.kind === 'cleanup' && job.session_ids.includes(id)).sort((a,b) => b.created_at.localeCompare(a.created_at))[0];
  return !!latest && ['failed', 'interrupted'].includes(latest.status);
}
