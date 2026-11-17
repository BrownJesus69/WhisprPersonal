import { Directory, File, Paths } from 'expo-file-system';
import { digest, CryptoDigestAlgorithm, randomUUID } from 'expo-crypto';
import type { ChunkSpec } from './chunker';
import { wavHeader } from './pcm';

export function sessionDirectory(id: string): Directory {
  if (!/^ses_[a-f0-9]{24}$/.test(id)) throw new Error('Invalid session id');
  return new Directory(Paths.document, 'whispr', 'sessions', id);
}
export function chunkDirectory(id: string) { return new Directory(sessionDirectory(id), 'chunks'); }
export function chunkName(spec: Omit<ChunkSpec, 'pcm'>, chunkId: string): string {
  return `${String(spec.sequence).padStart(6, '0')}_${spec.startMs}_${spec.endMs}_${spec.overlapMs}_${spec.continues ? 'c' : 'e'}_${chunkId}.wav`;
}
export function parseChunkName(name: string): (Omit<ChunkSpec, 'pcm'> & { chunkId: string }) | null {
  const m = /^(\d{6})_(\d+)_(\d+)_(\d+)_(c|e)_([a-f0-9]{32})\.wav$/.exec(name);
  if (!m) return null;
  const [sequence, startMs, endMs, overlapMs] = m.slice(1,5).map(Number);
  if (sequence > 100000 || endMs <= startMs || overlapMs > 3000 || endMs - startMs > 33000 || overlapMs >= endMs - startMs) return null;
  return { sequence, startMs, endMs, overlapMs, continues: m[5] === 'c', chunkId: m[6] };
}
export async function hashFile(uri: string) {
  const file = new File(uri);
  // Chunks are bounded (<= 16.5s); master files never enter this code path.
  if (file.size > 1100000) throw new Error('Invalid chunk size');
  const bytes = await file.bytes();
  const hash = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes));
  return { uri, sizeBytes: bytes.length, sha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('') };
}
export async function writeChunk(sessionId: string, spec: ChunkSpec) {
  const dir = chunkDirectory(sessionId);
  dir.create({ intermediates: true, idempotent: true });
  const chunkId = randomUUID().replace(/-/g, '').toLowerCase();
  const name = chunkName(spec, chunkId);
  const file = new File(dir, `${name}.part`);
  file.create();
  const handle = file.open();
  try { await handle.writeBytes(wavHeader(spec.pcm.length)); await handle.writeBytes(spec.pcm); }
  finally { handle.close(); }
  // File.move is asynchronous in Expo SDK 58; hash only once the rename has completed, and use
  // the final path (never the .part path) as the stored chunk uri.
  const final = new File(dir, name);
  await file.move(final);
  return { chunkId, ...await hashFile(final.uri) };
}
export function listChunkFiles(sessionId: string): File[] {
  const dir = chunkDirectory(sessionId);
  return dir.exists ? dir.list().filter((f): f is File => f instanceof File && parseChunkName(f.name) !== null).sort((a,b) => a.name.localeCompare(b.name)) : [];
}
export function removeParts(sessionId: string) {
  const dir = chunkDirectory(sessionId);
  if (dir.exists) for (const file of dir.list()) if (file instanceof File && file.name.endsWith('.wav.part')) file.delete();
}
/** Streams at most 2MiB per native read. Ignores stale WAV length fields after a crash. */
export async function* readWavPcm(uri: string, fromMs: number, toMs?: number): AsyncGenerator<Uint8Array> {
  const h = new File(uri).open();
  try {
    const end = Math.min((h.size ?? 0) - ((h.size ?? 0) - 44) % 2, toMs === undefined ? Infinity : 44 + Math.round(toMs * 16) * 2);
    h.offset = 44 + Math.round(Math.max(0, fromMs) * 16) * 2;
    while ((h.offset ?? end) < end) {
      const bytes = await h.readBytes(Math.min(2 * 1024 * 1024, end - h.offset!));
      if (!bytes.length) break;
      yield bytes;
    }
  } finally { h.close(); }
}
export function deleteAudio(uri: string) { const f = new File(uri); if (f.exists) f.delete(); }
export function recordingStorageBytes(ownerSessions: { id: string }[]) {
  let total = 0;
  const walk = (dir: Directory) => { if (dir.exists) for (const entry of dir.list()) { if (entry instanceof Directory) walk(entry); else total += entry.size; } };
  for (const s of ownerSessions) walk(sessionDirectory(s.id));
  return total;
}
