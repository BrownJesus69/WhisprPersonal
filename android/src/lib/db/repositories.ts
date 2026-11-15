import type { SQLiteDatabase, SQLiteBindValue } from 'expo-sqlite';
import type { LanguageMode } from '@/types/models';
import { database } from './database';

export type SessionStatus = 'recording' | 'paused' | 'stopped' | 'interrupted' | 'finalizing' | 'finalized' | 'failed';
export interface LocalSession {
  id: string; event_id: string; owner_uid: string; status: SessionStatus;
  language_mode: LanguageMode; expected_languages: string[]; chunk_ms: number; overlap_ms: number;
  next_sequence: number; time_ms: number; master_uri: string; server_created: number;
  expected_chunk_count: number | null; finalize_status: string | null; consent_at: string | null;
  created_at: string; updated_at: string; last_error: string | null;
}
export type ChunkStatus = 'pending' | 'uploading' | 'uploaded' | 'transcribed' | 'failed_permanent';
export interface LocalChunk {
  chunk_id: string; session_id: string; sequence: number; start_ms: number; end_ms: number;
  overlap_ms: number; continues: number; uri: string; size_bytes: number; sha256: string;
  status: ChunkStatus; server_status: string | null; attempts: number; next_attempt_at: number;
  last_error: string | null; local_deleted: number; created_at: string; updated_at: string;
}
export interface SessionRepo {
  sessions(owner: string): Promise<LocalSession[]>;
  session(id: string): Promise<LocalSession | null>;
  putSession(session: LocalSession): Promise<void>;
  updateSession(id: string, patch: Partial<LocalSession>): Promise<void>;
}
export interface ChunkRepo {
  chunks(sessionId: string): Promise<LocalChunk[]>;
  insertChunk(chunk: LocalChunk, progress?: { next_sequence: number; time_ms: number }): Promise<void>;
  updateChunk(id: string, patch: Partial<LocalChunk>): Promise<void>;
  resetUploading(owner: string): Promise<void>;
}
export type Repositories = SessionRepo & ChunkRepo;
type SessionRow = Omit<LocalSession, 'expected_languages'> & { expected_languages: string };

const values = (row: object): SQLiteBindValue[] => Object.values(row) as SQLiteBindValue[];
function insertSql(table: string, row: object) {
  const keys = Object.keys(row);
  return `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
}
async function update(db: SQLiteDatabase, table: string, key: string, id: string, patch: object) {
  const row = { ...patch, updated_at: new Date().toISOString() };
  await db.runAsync(`UPDATE ${table} SET ${Object.keys(row).map(k => `${k}=?`).join(',')} WHERE ${key}=?`, [...values(row), id]);
}
export class SQLiteRepositories implements Repositories {
  constructor(private db: SQLiteDatabase) {}
  async sessions(owner: string) {
    const rows = await this.db.getAllAsync<SessionRow>('SELECT * FROM recording_sessions WHERE owner_uid=? ORDER BY created_at,id', owner);
    return rows.map(r => ({ ...r, expected_languages: JSON.parse(r.expected_languages) as string[] }));
  }
  async session(id: string) {
    const r = await this.db.getFirstAsync<SessionRow>('SELECT * FROM recording_sessions WHERE id=?', id);
    return r ? { ...r, expected_languages: JSON.parse(r.expected_languages) as string[] } : null;
  }
  async putSession(s: LocalSession) {
    const row = { ...s, expected_languages: JSON.stringify(s.expected_languages) };
    await this.db.withExclusiveTransactionAsync(async tx => { await tx.runAsync(insertSql('recording_sessions', row), values(row)); });
  }
  async updateSession(id: string, patch: Partial<LocalSession>) {
    const row = { ...patch, ...(patch.expected_languages ? { expected_languages: JSON.stringify(patch.expected_languages) } : {}) };
    await this.db.withExclusiveTransactionAsync(tx => update(tx, 'recording_sessions', 'id', id, row));
  }
  chunks(sessionId: string) {
    return this.db.getAllAsync<LocalChunk>('SELECT * FROM chunks WHERE session_id=? ORDER BY sequence', sessionId);
  }
  async insertChunk(c: LocalChunk, progress?: { next_sequence: number; time_ms: number }) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync(insertSql('chunks', c), values(c));
      if (progress) await tx.runAsync('UPDATE recording_sessions SET next_sequence=MAX(next_sequence,?), time_ms=MAX(time_ms,?), updated_at=? WHERE id=?', progress.next_sequence, progress.time_ms, new Date().toISOString(), c.session_id);
    });
  }
  async updateChunk(id: string, patch: Partial<LocalChunk>) {
    await this.db.withExclusiveTransactionAsync(tx => update(tx, 'chunks', 'chunk_id', id, patch));
  }
  async resetUploading(owner: string) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await tx.runAsync("UPDATE chunks SET status='pending' WHERE status='uploading' AND session_id IN (SELECT id FROM recording_sessions WHERE owner_uid=?)", owner);
    });
  }
}
let instance: Promise<Repositories> | undefined;
export function repositories() { return instance ??= database().then(db => new SQLiteRepositories(db)).catch(e => { instance = undefined; throw e; }); }

export function chunkRow(sessionId: string, spec: { sequence: number; startMs: number; endMs: number; overlapMs: number; continues: boolean }, file: { chunkId: string; uri: string; sizeBytes: number; sha256: string }): LocalChunk {
  const now = new Date().toISOString();
  return { chunk_id: file.chunkId, session_id: sessionId, sequence: spec.sequence, start_ms: spec.startMs,
    end_ms: spec.endMs, overlap_ms: spec.overlapMs, continues: Number(spec.continues), uri: file.uri,
    size_bytes: file.sizeBytes, sha256: file.sha256, status: 'pending', server_status: null,
    attempts: 0, next_attempt_at: 0, last_error: null, local_deleted: 0, created_at: now, updated_at: now };
}
