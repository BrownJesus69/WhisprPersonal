import { Chunker, type ChunkSpec } from '@/lib/audio/chunker';
const opts = { sampleRate: 16000 as const, chunkMs: 10000, overlapMs: 1200 };
const audio = (ms: number) => Uint8Array.from({ length: ms * 32 }, (_,i) => (i * 37 + Math.floor(i / 256)) % 256);
function run(bytes: Uint8Array, splits: number[]) {
  const c = new Chunker(opts); const chunks: ChunkSpec[] = []; let start = 0;
  for (const n of splits) { chunks.push(...c.push(bytes.subarray(start, start + n))); start += n; }
  chunks.push(...c.push(bytes.subarray(start))); const tail = c.flush('stop'); if (tail) chunks.push(tail);
  return chunks;
}
test('10s/1.2s boundaries preserve overlap and reproduce every sample', () => {
  const bytes = audio(32500); const chunks = run(bytes, []);
  expect(chunks.map(c => [c.sequence,c.startMs,c.endMs,c.overlapMs,c.continues])).toEqual([
    [0,0,10000,0,true],[1,8800,20000,1200,true],[2,18800,30000,1200,true],[3,28800,32500,1200,false]
  ]);
  for (let i = 1; i < chunks.length; i++) expect(chunks[i].pcm.slice(0,38400)).toEqual(chunks[i-1].pcm.slice(-38400));
  const rebuilt = Buffer.concat(chunks.map(c => c.pcm.slice(c.overlapMs * 32)));
  expect(rebuilt.equals(Buffer.from(bytes))).toBe(true);
});
test('seeded random odd and tiny splits are identical to one push', () => {
  const input = audio(21500); const expected = run(input, []);
  let seed = 12345;
  for (let iteration = 0; iteration < 12; iteration++) {
    let left = input.length; const splits = [];
    while (left > 0) { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; const n = Math.min(left, 1 + seed % 10007); splits.push(n); left -= n; }
    const actual = run(input, splits);
    expect(actual.map(c => ({ ...c, pcm: undefined }))).toEqual(expected.map(c => ({ ...c, pcm: undefined })));
    actual.forEach((c,i) => expect(Buffer.from(c.pcm).equals(Buffer.from(expected[i].pcm))).toBe(true));
  }
  expect(run(input.subarray(0,6400), Array(6400).fill(1))).toEqual(run(input.subarray(0,6400), []));
});
test('pause flush ends run and resume resets overlap with monotone sequences', () => {
  const c = new Chunker(opts);
  c.push(audio(10500)); const end = c.flush('pause')!;
  expect(end.continues).toBe(false); expect(end.overlapMs).toBe(1200);
  const resumed = c.push(audio(10000))[0];
  expect(resumed).toMatchObject({ sequence: 2, startMs: 10500, endMs: 20500, overlapMs: 0 });
  expect(c.timeMs).toBe(20500); expect(c.nextSequence).toBe(3);
});
test('flush drops only new audio below 200ms, counting its time', () => {
  const c = new Chunker(opts); c.push(audio(10199)); expect(c.flush('pause')).toBeNull();
  expect(c.timeMs).toBe(10199);
  c.push(audio(200)); expect(c.flush('stop')).toMatchObject({ sequence: 1, startMs: 10199, endMs: 10399, overlapMs: 0, continues: false });
});
