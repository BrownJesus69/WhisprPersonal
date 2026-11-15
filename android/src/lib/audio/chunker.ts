export interface ChunkSpec {
  sequence: number; startMs: number; endMs: number; overlapMs: number;
  continues: boolean; pcm: Uint8Array;
}
export interface ChunkerOptions {
  sampleRate: 16000; chunkMs: number; overlapMs: number;
  startSequence?: number; startTimeMs?: number;
  /** Recovery only: seed already committed audio without counting it twice. */
  headPcm?: Uint8Array;
}

/** All boundaries use samples. Pauses reset the overlap, but never the session clock. */
export class Chunker {
  private pending = new Uint8Array(0);
  private head: Uint8Array;
  private odd: number | null = null;
  private samples: number;
  private sequence: number;
  private chunkBytes: number;
  private overlapBytes: number;
  constructor(o: ChunkerOptions) {
    if (o.sampleRate !== 16000 || o.chunkMs < 5000 || o.chunkMs > 15000 ||
      o.overlapMs < 1000 || o.overlapMs > 1500 || !Number.isInteger(o.chunkMs * 16) || !Number.isInteger(o.overlapMs * 16))
      throw new Error('Invalid chunk settings');
    this.chunkBytes = o.chunkMs * 32;
    this.overlapBytes = o.overlapMs * 32;
    this.head = o.headPcm?.slice() ?? new Uint8Array(0);
    if (this.head.length > this.overlapBytes || this.head.length % 2) throw new Error('Invalid recovery overlap');
    this.samples = Math.round((o.startTimeMs ?? 0) * 16);
    this.sequence = o.startSequence ?? 0;
  }
  get timeMs(): number { return Math.round(this.samples / 16); }
  get nextSequence(): number { return this.sequence; }
  state() { return { nextSequence: this.sequence, timeMs: this.timeMs, pendingSamples: this.pending.length / 2, oddByte: this.odd }; }
  push(pcm: Uint8Array): ChunkSpec[] {
    const joined = new Uint8Array(this.pending.length + pcm.length + (this.odd === null ? 0 : 1));
    joined.set(this.pending);
    let offset = this.pending.length;
    if (this.odd !== null) joined[offset++] = this.odd;
    joined.set(pcm, offset);
    this.odd = joined.length % 2 ? joined[joined.length - 1] : null;
    const even = joined.subarray(0, joined.length - joined.length % 2);
    // Previously pending samples are already counted in the session clock.
    this.samples += (even.length - this.pending.length) / 2;
    const result: ChunkSpec[] = [];
    let consumed = 0;
    while (even.length - consumed >= this.chunkBytes) {
      const endSamples = this.samples - (even.length - consumed - this.chunkBytes) / 2;
      result.push(this.emit(even.subarray(consumed, consumed + this.chunkBytes), endSamples, true));
      consumed += this.chunkBytes;
    }
    this.pending = even.slice(consumed);
    return result;
  }
  private emit(fresh: Uint8Array, endSamples: number, continues: boolean): ChunkSpec {
    const pcm = new Uint8Array(this.head.length + fresh.length);
    pcm.set(this.head); pcm.set(fresh, this.head.length);
    const result = { sequence: this.sequence++, startMs: Math.round((endSamples - pcm.length / 2) / 16),
      endMs: Math.round(endSamples / 16), overlapMs: this.head.length / 32, continues, pcm };
    this.head = pcm.slice(-this.overlapBytes);
    return result;
  }
  flush(_reason: 'pause' | 'stop'): ChunkSpec | null {
    // A trailing fragment below 200ms is deliberately omitted; its audio clock still advances.
    const spec = this.pending.length >= 6400 ? this.emit(this.pending, this.samples, false) : null;
    this.pending = new Uint8Array(0); this.head = new Uint8Array(0); this.odd = null;
    return spec;
  }
}
