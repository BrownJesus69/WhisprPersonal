import { writeTransaction } from './writeQueue';
import type { Translation, TranslationJob, Target } from '../translation/types';
import type { AIJob, BriefDraft, PolishedChunk } from '../ai/types';
import { normalizeSearch, escapeLike, type Note, type SyncState } from '../notes/model';
import type { SQLiteDatabase, SQLiteBindValue } from 'expo-sqlite';
import type { LanguageMode } from '@/types/models';
import { database } from './database';
import type { FinalData, PersistedEvent } from '../live/events';

export type SessionStatus = 'recording' | 'paused' | 'stopped' | 'interrupted' | 'finalizing' | 'finalized' | 'failed';
export interface LocalSession {
  id: string; event_id: string; owner_uid: string; status: SessionStatus;
  language_mode: LanguageMode; expected_languages: string[]; chunk_ms: number; overlap_ms: number;
  next_sequence: number; time_ms: number; master_uri: string; server_created: number;
  expected_chunk_count: number | null; finalize_status: string | null; consent_at: string | null;
  created_at: string; updated_at: string; last_error: string | null;
  last_event_seq?: number; language_override?: LanguageMode; override_from_sequence?: number | null;
  server_finalized_at?: string | null;
}
export type ChunkStatus = 'pending' | 'uploading' | 'uploaded' | 'transcribed' | 'failed_permanent';
export interface LocalChunk {
  chunk_id: string; session_id: string; sequence: number; start_ms: number; end_ms: number;
  overlap_ms: number; continues: number; uri: string; size_bytes: number; sha256: string;
  status: ChunkStatus; server_status: string | null; attempts: number; next_attempt_at: number;
  last_error: string | null; local_deleted: number; created_at: string; updated_at: string;
}
export interface PendingServerDelete { session_id: string; event_id: string; owner_uid: string }
export interface SessionRepo {
  deleteSessionRows(id: string, owner: string, pending: boolean): Promise<void>;
  pendingServerDeletes(owner: string): Promise<PendingServerDelete[]>;
  clearServerDelete(id: string, owner: string): Promise<void>;
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
export interface TranscriptRow extends FinalData {
  polished_text?: string | null; polished_level?: 'conservative' | 'polished' | null; polish_error?: string | null;
  session_id: string; revision: number; updated_at: string; failed_code: string | null;
}
export interface LanguageEventRow {
  session_id: string; seq: number; type: string; language: string | null; from_language: string | null;
  at_sequence: number | null; confidence: number | null; created_at: string;
}
export interface TranscriptRepo {
  upsertTranscript(row: TranscriptRow, observedSeq?: number): Promise<void>;
  transcript(sessionId: string): Promise<TranscriptRow[]>;
  appendLanguageEvent(row: LanguageEventRow): Promise<void>;
  languageEvents(sessionId: string): Promise<LanguageEventRow[]>;
  streamEvents(sessionId: string): Promise<PersistedEvent[]>;
  persistEvent(event: PersistedEvent): Promise<void>;
  setLastEventSeq(sessionId: string, seq: number): Promise<void>;
  resetLastEventSeq(sessionId: string): Promise<void>;
  setLanguageOverride(sessionId: string, mode: LanguageMode, fromSequence: number): Promise<void>;
}
export type NotePatch = Partial<Note> | ((current: Note) => Partial<Note>);
export interface TranscriptSearchResult extends TranscriptRow { event_id: string }
export interface NoteRepo {
  noteEventIds(owner: string): Promise<string[]>;
  noteStates(owner: string, eventId: string): Promise<SyncState[]>;
  putNote(note: Note): Promise<void>;
  note(id: string): Promise<Note | null>;
  notes(owner: string, eventId: string, search?: string): Promise<Note[]>;
  pendingNotes(owner: string, now: number): Promise<Note[]>;
  updateNote(id: string, patch: NotePatch): Promise<void>;
  searchNotes(owner: string, q: string, limit: number): Promise<Note[]>;
  searchTranscripts(owner: string, q: string, limit: number): Promise<TranscriptSearchResult[]>;
}
export interface AIRepo {
  putAIJob(job: AIJob): Promise<void>;
  aiJobs(owner: string, eventId?: string): Promise<AIJob[]>;
  finishAIJob(job: AIJob, draft?: BriefDraft): Promise<void>;
  storePolished(sessionId: string, chunks: PolishedChunk[], originals: TranscriptRow[]): Promise<void>;
  briefDrafts(owner: string, eventId: string): Promise<BriefDraft[]>;
  putBriefDraft(draft: BriefDraft): Promise<void>;
  deleteBriefDraft(owner: string, id: string): Promise<void>;
}
export interface TranslationRepo {
  translations(sessionId: string, target: Target): Promise<Translation[]>;
  storeTranslations(sessionId: string, target: Target, rows: Translation[]): Promise<void>;
  translationJobs(owner: string, eventId?: string): Promise<TranslationJob[]>;
  putTranslationJob(job: TranslationJob): Promise<void>;
}
export type Repositories = TranslationRepo & SessionRepo & ChunkRepo & TranscriptRepo & NoteRepo & AIRepo;
export function transcriptRow(sessionId: string, data: FinalData, ts = new Date().toISOString()): TranscriptRow {
  return { ...data, session_id: sessionId, revision: 0, updated_at: ts, failed_code: null };
}
export function languageEventRow(e: PersistedEvent): LanguageEventRow | null {
  if (e.type === 'language_locked') return { session_id: e.session_id, seq: e.seq, type: e.type, language: e.data.language, from_language: null, at_sequence: e.data.at_sequence, confidence: e.data.confidence, created_at: e.ts };
  if (e.type === 'language_changed') return { session_id: e.session_id, seq: e.seq, type: e.type, language: e.data.to, from_language: e.data.from, at_sequence: e.data.at_sequence, confidence: null, created_at: e.ts };
  if (e.type === 'language_override') return { session_id: e.session_id, seq: e.seq, type: e.type, language: e.data.language, from_language: null, at_sequence: null, confidence: null, created_at: e.ts };
  return null;
}
type TranscriptSqlRow = Omit<TranscriptRow, 'segments' | 'language_uncertain' | 'no_speech'> & { segments_json: string; language_uncertain: number; no_speech: number };
export const TRANSCRIPT_UPSERT = `INSERT INTO transcript_chunks
  (session_id,sequence,chunk_id,start_ms,end_ms,raw_text,segments_json,detected_language,language_confidence,language_source,language_uncertain,no_speech,failed_code,revision,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(session_id,sequence) DO UPDATE SET
  chunk_id=excluded.chunk_id,start_ms=excluded.start_ms,end_ms=excluded.end_ms,
  revision=transcript_chunks.revision + CASE WHEN transcript_chunks.raw_text != excluded.raw_text THEN 1 ELSE 0 END,
  polished_text=CASE WHEN transcript_chunks.raw_text != excluded.raw_text THEN NULL ELSE transcript_chunks.polished_text END,
  polished_level=CASE WHEN transcript_chunks.raw_text != excluded.raw_text THEN NULL ELSE transcript_chunks.polished_level END,
  polish_error=CASE WHEN transcript_chunks.raw_text != excluded.raw_text THEN NULL ELSE transcript_chunks.polish_error END,
  raw_text=excluded.raw_text,segments_json=excluded.segments_json,detected_language=excluded.detected_language,
  language_confidence=excluded.language_confidence,language_source=excluded.language_source,
  language_uncertain=excluded.language_uncertain,no_speech=excluded.no_speech,failed_code=excluded.failed_code,updated_at=excluded.updated_at`;
async function upsertTranscript(db: SQLiteDatabase, r: TranscriptRow) {
  await db.runAsync(TRANSCRIPT_UPSERT, [r.session_id,r.sequence,r.chunk_id,r.start_ms,r.end_ms,r.raw_text,JSON.stringify(r.segments),r.detected_language,r.language_confidence,r.language_source,Number(r.language_uncertain),Number(r.no_speech),r.failed_code,r.updated_at]);
}
async function appendLanguageEvent(db: SQLiteDatabase, r: LanguageEventRow) {
  await db.runAsync(`${insertSql('language_events', r)} ON CONFLICT(session_id,seq) DO NOTHING`, values(r));
}
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
  translations(sessionId: string, target: Target) {
    return this.db.getAllAsync<Translation>('SELECT * FROM translations WHERE session_id=? AND target_lang=? ORDER BY sequence',sessionId,target);
  }
  async storeTranslations(sessionId: string, target: Target, rows: Translation[]) {
    await writeTransaction(this.db, async tx => {
      // A late response after deletion must never resurrect session content.
      if (!await tx.getFirstAsync('SELECT id FROM recording_sessions WHERE id=?',sessionId)) return;
      await tx.runAsync('DELETE FROM translations WHERE session_id=? AND target_lang=?',sessionId,target);
      for (const r of rows) if (r.session_id === sessionId && r.target_lang === target) await tx.runAsync(insertSql('translations', r),values(r));
    });
  }
  async translationJobs(owner: string, eventId?: string): Promise<TranslationJob[]> {
    const rows = await this.db.getAllAsync<Omit<TranslationJob,'session_ids'> & {session_ids: string}>(`SELECT * FROM translation_jobs WHERE owner_uid=?${eventId ? ' AND event_id=?' : ''} ORDER BY created_at DESC,job_id DESC`,eventId ? [owner,eventId] : [owner]);
    return rows.map(r => ({ ...r, session_ids: JSON.parse(r.session_ids) }));
  }
  async putTranslationJob(job: TranslationJob) {
    await writeTransaction(this.db, async tx => {
      for (const id of job.session_ids) if (!await tx.getFirstAsync('SELECT id FROM recording_sessions WHERE id=? AND owner_uid=?',id,job.owner_uid)) return;
      const row = { ...job, session_ids: JSON.stringify(job.session_ids) };
      await tx.runAsync(`${insertSql('translation_jobs',row)} ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,updated_at=excluded.updated_at`,values(row));
    });
  }
  pendingServerDeletes(owner: string) { return this.db.getAllAsync<PendingServerDelete>('SELECT * FROM pending_server_deletes WHERE owner_uid=?',owner); }
  async clearServerDelete(id: string, owner: string) { await this.db.runAsync('DELETE FROM pending_server_deletes WHERE session_id=? AND owner_uid=?',id,owner); }
  async deleteSessionRows(id: string, owner: string, pending: boolean) {
    await writeTransaction(this.db, async tx => {
      const session = await tx.getFirstAsync<LocalSession>('SELECT * FROM recording_sessions WHERE id=? AND owner_uid=?',id,owner);
      if (!session) return;
      if (pending) await tx.runAsync('INSERT OR IGNORE INTO pending_server_deletes VALUES (?,?,?)',id,session.event_id,owner);
      for (const table of ['translations','chunks','transcript_chunks','stream_events','language_events']) await tx.runAsync(`DELETE FROM ${table} WHERE session_id=?`,id);
      await tx.runAsync('DELETE FROM ai_jobs WHERE owner_uid=? AND EXISTS (SELECT 1 FROM json_each(ai_jobs.session_ids) WHERE value=?)',owner,id);
      await tx.runAsync('DELETE FROM translation_jobs WHERE owner_uid=? AND EXISTS (SELECT 1 FROM json_each(translation_jobs.session_ids) WHERE value=?)',owner,id);
      await tx.runAsync('DELETE FROM recording_sessions WHERE id=? AND owner_uid=?',id,owner);
    });
  }
  async putAIJob(job: AIJob) {
    const row = { ...job, session_ids: JSON.stringify(job.session_ids) };
    await this.db.runAsync(`${insertSql('ai_jobs', row)} ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,updated_at=excluded.updated_at`, values(row));
  }
  async aiJobs(owner: string, eventId?: string): Promise<AIJob[]> {
    const rows = await this.db.getAllAsync<Omit<AIJob, 'session_ids'> & { session_ids: string }>(`SELECT * FROM ai_jobs WHERE owner_uid=?${eventId ? ' AND event_id=?' : ''} ORDER BY created_at DESC,job_id DESC`, eventId ? [owner,eventId] : [owner]);
    return rows.map(r => ({ ...r, session_ids: JSON.parse(r.session_ids) }));
  }
  async finishAIJob(job: AIJob, draft?: BriefDraft) {
    await writeTransaction(this.db, async tx => {
      if (draft) {
        const row = { ...draft, session_ids: JSON.stringify(draft.session_ids) };
        await tx.runAsync(`${insertSql('brief_drafts', row)} ON CONFLICT(id) DO NOTHING`, values(row));
      }
      await tx.runAsync('UPDATE ai_jobs SET status=?,error_code=?,updated_at=? WHERE job_id=? AND owner_uid=?',job.status,job.error_code,job.updated_at,job.job_id,job.owner_uid);
    });
  }
  async storePolished(sessionId: string, chunks: PolishedChunk[], originals: TranscriptRow[]) {
    await writeTransaction(this.db, async tx => {
      for (const c of chunks) {
        const original = originals.find(r => r.sequence === c.sequence);
        if (!original) continue;
        await tx.runAsync('UPDATE transcript_chunks SET polished_text=?,polished_level=?,polish_error=? WHERE session_id=? AND sequence=? AND raw_text=? AND revision=?',c.polished_text,c.polished_level,c.polish_error,sessionId,c.sequence,original.raw_text,original.revision);
      }
    });
  }
  async briefDrafts(owner: string, eventId: string): Promise<BriefDraft[]> {
    const rows = await this.db.getAllAsync<Omit<BriefDraft, 'session_ids'> & { session_ids: string }>('SELECT * FROM brief_drafts WHERE owner_uid=? AND event_id=? ORDER BY created_at DESC,id DESC',owner,eventId);
    return rows.map(r => ({ ...r, session_ids: JSON.parse(r.session_ids) }));
  }
  async putBriefDraft(draft: BriefDraft) {
    const row = { ...draft, session_ids: JSON.stringify(draft.session_ids) };
    await this.db.runAsync(`${insertSql('brief_drafts', row)} ON CONFLICT(id) DO UPDATE SET edited_text=excluded.edited_text,status=excluded.status,updated_at=excluded.updated_at`,values(row));
  }
  async deleteBriefDraft(owner: string, id: string) { await this.db.runAsync("DELETE FROM brief_drafts WHERE id=? AND owner_uid=? AND status='draft'",id,owner); }

  async noteEventIds(owner: string) {
    return (await this.db.getAllAsync<{ event_id: string }>('SELECT DISTINCT event_id FROM notes WHERE owner_uid=? ORDER BY event_id', owner)).map(n => n.event_id);
  }
  async noteStates(owner: string, eventId: string) {
    return (await this.db.getAllAsync<{ sync_state: SyncState }>('SELECT sync_state FROM notes WHERE owner_uid=? AND event_id=?', owner,eventId)).map(n => n.sync_state);
  }
  async putNote(note: Note) {
    await writeTransaction(this.db, async tx => { await tx.runAsync(insertSql('notes', note), values(note)); });
  }
  note(id: string) { return this.db.getFirstAsync<Note>('SELECT * FROM notes WHERE id=?', id); }
  notes(owner: string, eventId: string, search = '') {
    return this.db.getAllAsync<Note>("SELECT * FROM notes WHERE owner_uid=? AND event_id=? AND (deleted=0 OR sync_state IN ('conflict','failed')) AND search_text LIKE ? ESCAPE '\\' ORDER BY timestamp_ms,created_at,id", owner, eventId, `%${escapeLike(normalizeSearch(search))}%`);
  }
  pendingNotes(owner: string, now: number) {
    return this.db.getAllAsync<Note>("SELECT * FROM notes WHERE owner_uid=? AND sync_state='pending' AND next_attempt_at<=? ORDER BY updated_at,id LIMIT 50", owner, now);
  }
  async updateNote(id: string, patch: NotePatch) {
    await writeTransaction(this.db, async tx => {
      const current = await tx.getFirstAsync<Note>('SELECT * FROM notes WHERE id=?', id);
      if (!current) return;
      const row = typeof patch === 'function' ? patch(current) : patch;
      if (!Object.keys(row).length) return;
      await tx.runAsync(`UPDATE notes SET ${Object.keys(row).map(k => `${k}=?`).join(',')} WHERE id=?`, [...values(row), id]);
    });
  }
  searchNotes(owner: string, q: string, cap: number) {
    return this.db.getAllAsync<Note>("SELECT * FROM notes WHERE owner_uid=? AND deleted=0 AND search_text LIKE ? ESCAPE '\\' ORDER BY updated_at DESC,id DESC LIMIT ?", owner, `%${escapeLike(normalizeSearch(q))}%`, cap);
  }
  async searchTranscripts(owner: string, q: string, cap: number): Promise<TranscriptSearchResult[]> {
    // Normalize in JS: SQLite lower() cannot fold Unicode, and v2 rows have no search column.
    // segments_json (word timings) is the bulk of each row and search never shows it: skip it.
    const rows = await this.db.getAllAsync<Omit<TranscriptSqlRow, 'segments_json'> & { event_id: string }>(`SELECT t.session_id,t.sequence,t.chunk_id,t.start_ms,t.end_ms,t.raw_text,t.detected_language,
      t.language_confidence,t.language_source,t.language_uncertain,t.no_speech,t.failed_code,t.revision,t.updated_at,s.event_id
      FROM transcript_chunks t JOIN recording_sessions s ON t.session_id=s.id WHERE s.owner_uid=? AND t.no_speech=0 ORDER BY t.updated_at DESC,t.session_id DESC,t.sequence DESC`, owner);
    const needle = normalizeSearch(q);
    return rows.filter(r => normalizeSearch(r.raw_text).includes(needle)).slice(0,cap).map(r => ({ ...r, segments: [], language_uncertain: !!r.language_uncertain, no_speech: !!r.no_speech }));
  }
  async upsertTranscript(row: TranscriptRow, observedSeq?: number) {
    await writeTransaction(this.db, async tx => {
      if (observedSeq !== undefined) {
        const session = await tx.getFirstAsync<{ last_event_seq: number }>('SELECT last_event_seq FROM recording_sessions WHERE id=?', row.session_id);
        if (!session || session.last_event_seq > observedSeq) return;
      }
      await upsertTranscript(tx, row);
    });
  }
  async transcript(id: string): Promise<TranscriptRow[]> {
    const rows = await this.db.getAllAsync<TranscriptSqlRow>('SELECT * FROM transcript_chunks WHERE session_id=? ORDER BY sequence', id);
    return rows.map(({ segments_json, ...r }) => ({ ...r, segments: JSON.parse(segments_json), language_uncertain: !!r.language_uncertain, no_speech: !!r.no_speech }));
  }
  async appendLanguageEvent(row: LanguageEventRow) { await writeTransaction(this.db, tx => appendLanguageEvent(tx, row)); }
  languageEvents(id: string) { return this.db.getAllAsync<LanguageEventRow>('SELECT * FROM language_events WHERE session_id=? ORDER BY seq', id); }
  async streamEvents(id: string): Promise<PersistedEvent[]> {
    return (await this.db.getAllAsync<{ event_json: string }>('SELECT event_json FROM stream_events WHERE session_id=? ORDER BY seq', id)).map(r => JSON.parse(r.event_json));
  }
  async persistEvent(e: PersistedEvent) {
    await writeTransaction(this.db, async tx => {
      const s = await tx.getFirstAsync<{ last_event_seq: number }>('SELECT last_event_seq FROM recording_sessions WHERE id=?', e.session_id);
      if (!s || e.seq <= s.last_event_seq) return;
      if (e.type === 'transcript_final' || e.type === 'transcript_revised') await upsertTranscript(tx, transcriptRow(e.session_id, e.data, e.ts));
      const language = languageEventRow(e); if (language) await appendLanguageEvent(tx, language);
      await tx.runAsync('INSERT INTO stream_events (session_id,seq,event_json) VALUES (?,?,?)', e.session_id, e.seq, JSON.stringify(e));
      if (e.type === 'session_finalized') await tx.runAsync("UPDATE recording_sessions SET status='finalized',server_finalized_at=?,finalize_status=? WHERE id=?", e.ts, e.data.transcript_status, e.session_id);
      await tx.runAsync('UPDATE recording_sessions SET last_event_seq=MAX(last_event_seq,?) WHERE id=?', e.seq, e.session_id);
    });
  }
  async setLastEventSeq(id: string, seq: number) {
    await writeTransaction(this.db, async tx => { await tx.runAsync('UPDATE recording_sessions SET last_event_seq=MAX(last_event_seq,?) WHERE id=?', seq, id); });
  }
  async resetLastEventSeq(id: string) {
    await writeTransaction(this.db, async tx => {
      await tx.runAsync('DELETE FROM stream_events WHERE session_id=?', id);
      await tx.runAsync('DELETE FROM language_events WHERE session_id=?', id);
      await tx.runAsync('UPDATE recording_sessions SET last_event_seq=0,server_finalized_at=NULL WHERE id=?', id);
    });
  }
  async setLanguageOverride(id: string, mode: LanguageMode, fromSequence: number) {
    await this.updateSession(id, { language_override: mode, override_from_sequence: fromSequence });
  }
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
    await writeTransaction(this.db, async tx => { await tx.runAsync(insertSql('recording_sessions', row), values(row)); });
  }
  async updateSession(id: string, patch: Partial<LocalSession>) {
    const row = { ...patch, ...(patch.expected_languages ? { expected_languages: JSON.stringify(patch.expected_languages) } : {}) };
    await writeTransaction(this.db, tx => update(tx, 'recording_sessions', 'id', id, row));
  }
  chunks(sessionId: string) {
    return this.db.getAllAsync<LocalChunk>('SELECT * FROM chunks WHERE session_id=? ORDER BY sequence', sessionId);
  }
  async insertChunk(c: LocalChunk, progress?: { next_sequence: number; time_ms: number }) {
    await writeTransaction(this.db, async tx => {
      await tx.runAsync(insertSql('chunks', c), values(c));
      if (progress) await tx.runAsync('UPDATE recording_sessions SET next_sequence=MAX(next_sequence,?), time_ms=MAX(time_ms,?), updated_at=? WHERE id=?', progress.next_sequence, progress.time_ms, new Date().toISOString(), c.session_id);
    });
  }
  async updateChunk(id: string, patch: Partial<LocalChunk>) {
    await writeTransaction(this.db, tx => update(tx, 'chunks', 'chunk_id', id, patch));
  }
  async resetUploading(owner: string) {
    await writeTransaction(this.db, async tx => {
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
