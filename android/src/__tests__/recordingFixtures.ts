import type { LocalSession, LocalChunk } from '@/lib/db/repositories';
export function session(patch: Partial<LocalSession> = {}): LocalSession {
  return { id: 'ses_123456789012345678901234', event_id: 'event-1', owner_uid: 'owner', status: 'recording',
    language_mode: 'auto', expected_languages: [], chunk_ms: 10000, overlap_ms: 1200, next_sequence: 0,
    time_ms: 0, master_uri: 'file:///master.wav', server_created: 0, expected_chunk_count: null,
    finalize_status: null, consent_at: '2026-11-15T00:00:00Z', created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', last_error: null, ...patch };
}
export function chunk(sequence = 0, patch: Partial<LocalChunk> = {}): LocalChunk {
  return { chunk_id: `chunk_${sequence}`, session_id: session().id, sequence, start_ms: sequence * 10000,
    end_ms: (sequence + 1) * 10000, overlap_ms: sequence ? 1200 : 0, continues: 1, uri: `file:///chunk_${sequence}.wav`,
    size_bytes: 320044, sha256: 'a'.repeat(64), status: 'pending', server_status: null, attempts: 0,
    next_attempt_at: 0, last_error: null, local_deleted: 0, created_at: session().created_at,
    updated_at: session().created_at, ...patch };
}
