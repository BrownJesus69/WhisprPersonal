import { languageEventRow, transcriptRow, type Repositories, type LocalSession, type LocalChunk, type TranscriptRow, type LanguageEventRow } from './repositories';
import type { LanguageMode, PersistedEvent } from '../live/events';

/** Mirrors uniqueness and atomic progress updates for offline tests. */
export class MemoryRepositories implements Repositories {
  private sessionRows = new Map<string, LocalSession>();
  private chunkRows = new Map<string, LocalChunk>();
  private transcripts = new Map<string, TranscriptRow>();
  private languages = new Map<string, LanguageEventRow>();
  private events = new Map<string, PersistedEvent>();
  private putTranscript(r: TranscriptRow) {
    const key = `${r.session_id}:${r.sequence}`, old = this.transcripts.get(key);
    this.transcripts.set(key, structuredClone({ ...r, revision: old ? old.revision + Number(old.raw_text !== r.raw_text) : 0 }));
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
    this.sessionRows.set(s.id, { ...s, last_event_seq: e.seq, ...(e.type === 'session_finalized' ? { status: 'finalized' as const, server_finalized_at: e.ts } : {}) });
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
