import { Chunker } from '@/lib/audio/chunker';
import { listChunkFiles, removeParts, hashFile, parseChunkName, readWavPcm, writeChunk } from '@/lib/audio/chunkFiles';
import { File } from 'expo-file-system';
import { chunkRow, type Repositories } from '@/lib/db/repositories';
import { updateEventStatus } from '@/lib/firebase/events';

const io = { listChunkFiles, removeParts, hashFile, parseChunkName, readWavPcm, writeChunk, masterExists: (uri: string) => new File(uri).exists };
export type RecoveryIO = typeof io;
/** Native output rotates after process death; the filename stores its session-time origin. */
export function masterOrigin(uri: string): number {
  return Number(/master_(\d+)(?:_[a-f0-9]+)?\.wav$/.exec(uri)?.[1] ?? 0);
}
export async function recoverSessions(repo: Repositories, owner: string, liveSessionId: string | null, files: RecoveryIO = io, notify: () => void = () => {}) {
  await repo.resetUploading(owner);
  for (const original of await repo.sessions(owner)) {
    if (original.id === liveSessionId) continue;
    files.removeParts(original.id);
    let chunks = await repo.chunks(original.id);
    for (const file of files.listChunkFiles(original.id)) {
      const spec = files.parseChunkName(file.name);
      if (!spec || chunks.some(c => c.chunk_id === spec.chunkId || c.sequence === spec.sequence)) continue;
      const metadata = { chunkId: spec.chunkId, ...await files.hashFile(file.uri) };
      await repo.insertChunk(chunkRow(original.id, spec, metadata), { next_sequence: spec.sequence + 1, time_ms: spec.endMs });
      chunks = await repo.chunks(original.id);
    }
    const s = (await repo.session(original.id))!;
    if (!s.consent_at) continue; // Ready session: native recording has never started.
    // 'interrupted' also covers a crash during this recovery pass.
    if (!['recording','paused','interrupted'].includes(s.status)) continue;
    await repo.updateSession(s.id, { status: 'interrupted', last_error: 'recording_interrupted' });
    if (!files.masterExists(s.master_uri)) {
      await repo.updateSession(s.id, { status: 'stopped', finalize_status: 'interrupted', last_error: 'master_unavailable' });
      updateEventStatus(s.event_id, 'processing');
      continue;
    }
    const origin = masterOrigin(s.master_uri);
    const last = chunks[chunks.length - 1];
    const overlap = last?.continues ? Math.min(s.overlap_ms, s.time_ms - origin) : 0;
    let head = new Uint8Array(0);
    for await (const bytes of files.readWavPcm(s.master_uri, Math.max(0, s.time_ms - origin - overlap), Math.max(0, s.time_ms - origin))) {
      const joined = new Uint8Array(head.length + bytes.length); joined.set(head); joined.set(bytes, head.length); head = joined;
    }
    const chunker = new Chunker({ sampleRate: 16000, chunkMs: s.chunk_ms, overlapMs: s.overlap_ms,
      startSequence: s.next_sequence, startTimeMs: s.time_ms, headPcm: head });
    const save = async (spec: NonNullable<ReturnType<Chunker['flush']>>) => {
      const file = await files.writeChunk(s.id, spec);
      await repo.insertChunk(chunkRow(s.id, spec, file), { next_sequence: spec.sequence + 1, time_ms: spec.endMs });
    };
    for await (const pcm of files.readWavPcm(s.master_uri, Math.max(0, s.time_ms - origin)))
      for (const spec of chunker.push(pcm)) await save(spec);
    const tail = chunker.flush('stop'); if (tail) await save(tail);
    await repo.updateSession(s.id, { status: 'stopped', time_ms: chunker.timeMs, next_sequence: chunker.nextSequence, finalize_status: 'interrupted' });
    updateEventStatus(s.event_id, 'processing');
  }
  notify();
}
