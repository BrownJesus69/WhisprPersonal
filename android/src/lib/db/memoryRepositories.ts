import type { AIJob, BriefDraft, PolishedChunk } from '../ai/types';
import { normalizeSearch, type Note } from '../notes/model';
import { languageEventRow, transcriptRow, type NotePatch, type Repositories, type LocalSession, type LocalChunk, type TranscriptRow, type LanguageEventRow } from './repositories';
import type { LanguageMode, PersistedEvent } from '../live/events';

/** Mirrors uniqueness and atomic progress updates for offline tests. */
export class MemoryRepositories implements Repositories {
  private deletes = new Map<string, import('./repositories').PendingServerDelete>();
  async pendingServerDeletes(owner: string) { return structuredClone([...this.deletes.values()].filter(d => d.owner_uid === owner)); }
  async clearServerDelete(id: string, owner: string) { if (this.deletes.get(id)?.owner_uid === owner) this.deletes.delete(id); }
  async deleteSessionRows(id: string, owner: string, pending: boolean) {
    const s = this.sessionRows.get(id); if (!s || s.owner_uid !== owner) return;
    if (pending) this.deletes.set(id,{ session_id: id, event_id: s.event_id, owner_uid: owner });
    for (const rows of [this.chunkRows,this.transcripts,this.languages,this.events]) for (const [key,row] of rows) if (row.session_id === id) rows.delete(key);
    for (const [key,job] of this.jobs) if (job.owner_uid === owner && job.session_ids.includes(id)) this.jobs.delete(key);
    this.sessionRows.delete(id);
  }
  private jobs = new Map<string, AIJob>();
  private drafts = new Map<string, BriefDraft>();
  async putAIJob(job: AIJob) {
    const old = this.jobs.get(job.job_id);
    this.jobs.set(job.job_id, structuredClone(old ? { ...old, status: job.status, error_code: job.error_code, updated_at: job.updated_at } : job));
  }
  async aiJobs(owner: string, eventId?: string) { return structuredClone([...this.jobs.values()].filter(j => j.owner_uid === owner && (!eventId || j.event_id === eventId)).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.job_id.localeCompare(a.job_id))); }
  async finishAIJob(job: AIJob, draft?: BriefDraft) {
    if (draft && !this.drafts.has(draft.id)) this.drafts.set(draft.id, structuredClone(draft));
    const old = this.jobs.get(job.job_id);
    if (old?.owner_uid === job.owner_uid) this.jobs.set(job.job_id, structuredClone({ ...old, status: job.status, error_code: job.error_code, updated_at: job.updated_at }));
  }
  async storePolished(sessionId: string, chunks: PolishedChunk[], originals: TranscriptRow[]) {
    for (const c of chunks) {
      const key = `${sessionId}:${c.sequence}`, row = this.transcripts.get(key), original = originals.find(r => r.sequence === c.sequence);
      if (row && original && row.raw_text === original.raw_text && row.revision === original.revision) this.transcripts.set(key, { ...row, polished_text: c.polished_text, polished_level: c.polished_level, polish_error: c.polish_error });
    }
  }
  async briefDrafts(owner: string, eventId: string) { return structuredClone([...this.drafts.values()].filter(d => d.owner_uid === owner && d.event_id === eventId).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))); }
  async putBriefDraft(draft: BriefDraft) {
    const old = this.drafts.get(draft.id);
    this.drafts.set(draft.id, structuredClone(old ? { ...old, edited_text: draft.edited_text, status: draft.status, updated_at: draft.updated_at } : draft));
  }
  async deleteBriefDraft(owner: string, id: string) { const d = this.drafts.get(id); if (d?.owner_uid === owner && d.status === 'draft') this.drafts.delete(id); }
  private noteRows = new Map<string, Note>();
  async noteEventIds(owner: string) { return [...new Set([...this.noteRows.values()].filter(n => n.owner_uid === owner).map(n => n.event_id))].sort(); }
  async noteStates(owner: string, eventId: string) { return [...this.noteRows.values()].filter(n => n.owner_uid === owner && n.event_id === eventId).map(n => n.sync_state); }
  async putNote(note: Note) { if (this.noteRows.has(note.id)) throw new Error('Duplicate note'); this.noteRows.set(note.id, structuredClone(note)); }
  async note(id: string) { return structuredClone(this.noteRows.get(id) ?? null); }
  async notes(owner: string, eventId: string, search = '') {
    return structuredClone([...this.noteRows.values()].filter(n => n.owner_uid === owner && n.event_id === eventId && (!n.deleted || ['conflict','failed'].includes(n.sync_state)) && n.search_text.includes(normalizeSearch(search))).sort((a,b) => (a.timestamp_ms === null && b.timestamp_ms === null ? 0 : a.timestamp_ms === null ? -1 : b.timestamp_ms === null ? 1 : a.timestamp_ms-b.timestamp_ms) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
  }
  async pendingNotes(owner: string, now: number) { return structuredClone([...this.noteRows.values()].filter(n => n.owner_uid === owner && n.sync_state === 'pending' && n.next_attempt_at <= now).sort((a,b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id)).slice(0,50)); }
  async updateNote(id: string, patch: NotePatch) { const n = this.noteRows.get(id); if (n) this.noteRows.set(id, structuredClone({ ...n, ...(typeof patch === 'function' ? patch(structuredClone(n)) : patch) })); }
  async searchNotes(owner: string, q: string, cap: number) { return structuredClone([...this.noteRows.values()].filter(n => n.owner_uid === owner && !n.deleted && n.search_text.includes(normalizeSearch(q))).sort((a,b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)).slice(0,cap)); }
  async searchTranscripts(owner: string, q: string, cap: number) {
    return structuredClone([...this.transcripts.values()].filter(r => this.sessionRows.get(r.session_id)?.owner_uid === owner && !r.no_speech && normalizeSearch(r.raw_text).includes(normalizeSearch(q))).sort((a,b) => b.updated_at.localeCompare(a.updated_at) || b.session_id.localeCompare(a.session_id) || b.sequence-a.sequence).slice(0,cap).map(r => ({ ...r, segments: [], event_id: this.sessionRows.get(r.session_id)!.event_id })));
  }
  private sessionRows = new Map<string, LocalSession>();
  private chunkRows = new Map<string, LocalChunk>();
  private transcripts = new Map<string, TranscriptRow>();
  private languages = new Map<string, LanguageEventRow>();
  private events = new Map<string, PersistedEvent>();
  private putTranscript(r: TranscriptRow) {
    const key = `${r.session_id}:${r.sequence}`, old = this.transcripts.get(key);
    this.transcripts.set(key, structuredClone({ ...r, polished_text: old?.raw_text === r.raw_text ? old.polished_text ?? null : null, polished_level: old?.raw_text === r.raw_text ? old.polished_level ?? null : null, polish_error: old?.raw_text === r.raw_text ? old.polish_error ?? null : null, revision: old ? old.revision + Number(old.raw_text !== r.raw_text) : 0 }));
  }
  async upsertTranscript(r: TranscriptRow, observedSeq?: number) {
    if (observedSeq !== undefined && (this.sessionRows.get(r.session_id)?.last_event_seq ?? 0) > observedSeq) return;
    this.putTranscript(r);
  }
  async transcript(id: string) { return structuredClone([...this.transcripts.values()].filter(r => r.session_id === id).sort((a,b) => a.sequence - b.sequence)); }
  async appendLanguageEvent(r: LanguageEventRow) { const key = `${r.session_id}:${r.seq}`; if (!this.languages.has(key)) this.languages.set(key, structuredClone(r)); }
  async languageEvents(id: string) { return structuredClone([...this.languages.values()].filter(r => r.session_id === id).sort((a,b) => a.seq - b.seq)); }
  async streamEvents(id: string) { return structuredClone([...this.events.values()].filter(r => r.session_id === id).sort((a,b) => a.seq - b.seq)); }
  async persistEvent(e: PersistedEvent) {
    const s = this.sessionRows.get(e.session_id);
    if (!s || e.seq <= (s.last_event_seq ?? 0)) return;
    // No await inside this critical section: mirror the SQL transaction atomically.
    if (e.type === 'transcript_final' || e.type === 'transcript_revised') this.putTranscript(transcriptRow(e.session_id, e.data, e.ts));
    const language = languageEventRow(e); if (language) this.languages.set(`${e.session_id}:${e.seq}`, structuredClone(language));
    this.events.set(`${e.session_id}:${e.seq}`, structuredClone(e));
    this.sessionRows.set(s.id, { ...s, last_event_seq: e.seq, ...(e.type === 'session_finalized' ? { status: 'finalized' as const, server_finalized_at: e.ts, finalize_status: e.data.transcript_status } : {}) });
  }
  async setLastEventSeq(id: string, seq: number) { const s = this.sessionRows.get(id); if (s) this.sessionRows.set(id, { ...s, last_event_seq: Math.max(s.last_event_seq ?? 0, seq) }); }
  async resetLastEventSeq(id: string) {
    for (const [key,e] of this.events) if (e.session_id === id) this.events.delete(key);
    for (const [key,e] of this.languages) if (e.session_id === id) this.languages.delete(key);
    const s = this.sessionRows.get(id); if (s) this.sessionRows.set(id, { ...s, last_event_seq: 0, server_finalized_at: null });
  }
  async setLanguageOverride(id: string, mode: LanguageMode, fromSequence: number) { await this.updateSession(id, { language_override: mode, override_from_sequence: fromSequence }); }
  async sessions(owner: string) { return [...this.sessionRows.values()].filter(s => s.owner_uid === owner).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(s => structuredClone(s)); }
  async session(id: string) { const s = this.sessionRows.get(id); return s ? structuredClone(s) : null; }
  async putSession(s: LocalSession) { if (this.sessionRows.has(s.id)) throw new Error('Duplicate session'); this.sessionRows.set(s.id, structuredClone({ last_event_seq: 0, language_override: 'auto', override_from_sequence: null, server_finalized_at: null, ...s })); }
  async updateSession(id: string, patch: Partial<LocalSession>) { const s = this.sessionRows.get(id); if (s) this.sessionRows.set(id, { ...s, ...patch }); }
  async chunks(id: string) { return [...this.chunkRows.values()].filter(c => c.session_id === id).sort((a,b) => a.sequence - b.sequence).map(c => ({ ...c })); }
  async insertChunk(c: LocalChunk, progress?: { next_sequence: number; time_ms: number }) {
    if (!this.sessionRows.has(c.session_id)) throw new Error('Missing session');
    if (this.chunkRows.has(c.chunk_id) || [...this.chunkRows.values()].some(r => r.session_id === c.session_id && r.sequence === c.sequence)) throw new Error('Duplicate chunk');
    this.chunkRows.set(c.chunk_id, { ...c });
    if (progress) { const s = this.sessionRows.get(c.session_id)!; await this.updateSession(s.id, { next_sequence: Math.max(s.next_sequence, progress.next_sequence), time_ms: Math.max(s.time_ms, progress.time_ms) }); }
  }
  async updateChunk(id: string, patch: Partial<LocalChunk>) { const c = this.chunkRows.get(id); if (c) this.chunkRows.set(id, { ...c, ...patch }); }
  async resetUploading(owner: string) { for (const s of await this.sessions(owner)) for (const c of await this.chunks(s.id)) if (c.status === 'uploading') await this.updateChunk(c.chunk_id, { status: 'pending' }); }
}
