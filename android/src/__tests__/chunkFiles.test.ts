import { File } from 'expo-file-system';
import { chunkName, parseChunkName, writeChunk, listChunkFiles, chunkDirectory, readWavPcm, removeParts } from '@/lib/audio/chunkFiles';
const id = 'ses_123456789012345678901234';
test('metadata round trip and part exclusion', () => {
  const spec = { sequence: 9, startMs: 8800, endMs: 20000, overlapMs: 1200, continues: true };
  const name = chunkName(spec, 'a'.repeat(32));
  expect(parseChunkName(name)).toEqual({ ...spec, chunkId: 'a'.repeat(32) });
  expect(parseChunkName(name + '.part')).toBeNull();
  const dir = chunkDirectory(id); dir.create();
  const part = new File(dir, name + '.part'); part.create();
  expect(listChunkFiles(id)).toEqual([]); removeParts(id); expect(part.exists).toBe(false);
});
test('write renames complete WAV and hashes file bytes; reads seek past header', async () => {
  const pcm = Uint8Array.from({ length: 16000 }, (_,i) => i % 256);
  const file = await writeChunk(id, { sequence: 1, startMs: 0, endMs: 500, overlapMs: 0, continues: false, pcm });
  expect(file.uri).toMatch(/\.wav$/); expect(file.sizeBytes).toBe(16044); expect(file.sha256).toHaveLength(64);
  const reads = []; for await (const bytes of readWavPcm(file.uri, 100, 200)) reads.push(bytes);
  expect(Buffer.concat(reads)).toEqual(Buffer.from(pcm.slice(3200,6400)));
  const tail = []; for await (const bytes of readWavPcm(file.uri, 450)) tail.push(bytes);
  expect(Buffer.concat(tail)).toEqual(Buffer.from(pcm.slice(14400)));
});
