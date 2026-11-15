import type { Repositories, LocalSession, LocalChunk } from './repositories';

/** Mirrors uniqueness and atomic progress updates without loading any native modules. */
export class MemoryRepositories implements Repositories {
  private sessionRows = new Map<string, LocalSession>();
  private chunkRows = new Map<string, LocalChunk>();
  async sessions(owner: string) { return [...this.sessionRows.values()].filter(s => s.owner_uid === owner).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(s => structuredClone(s)); }
  async session(id: string) { const s = this.sessionRows.get(id); return s ? structuredClone(s) : null; }
  async putSession(s: LocalSession) { if (this.sessionRows.has(s.id)) throw new Error('Duplicate session'); this.sessionRows.set(s.id, structuredClone(s)); }
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
