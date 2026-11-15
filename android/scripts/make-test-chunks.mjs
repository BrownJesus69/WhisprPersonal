// Node 24 strips types; this imports the production chunker, without a second implementation.
import { Chunker } from '../src/lib/audio/chunker.ts';
import { wavHeader } from '../src/lib/audio/pcm.ts';
import { open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const [input, chunkText = '10000', overlapText = '1200', output = 'test-chunks'] = process.argv.slice(2);
if (!input) throw new Error('Usage: node --experimental-strip-types scripts/make-test-chunks.mjs input.wav [chunkMs] [overlapMs] [outputDir]');
const chunker = new Chunker({ sampleRate: 16000, chunkMs: Number(chunkText), overlapMs: Number(overlapText) });
const source = await open(input, 'r');
try {
  const header = Buffer.alloc(44);
  await source.read(header, 0, 44, 0);
  if (header.toString('ascii', 0,4) !== 'RIFF' || header.toString('ascii',8,12) !== 'WAVE' || header.toString('ascii',12,16) !== 'fmt ' || header.readUInt32LE(16) !== 16 || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== 16000 || header.readUInt16LE(34) !== 16 || header.toString('ascii',36,40) !== 'data') throw new Error('Expected canonical 44-byte-header, 16 kHz mono 16-bit PCM WAV');
  await mkdir(output, { recursive: true });
  const save = async c => {
    const filename = `${c.sequence}_${c.startMs}_${c.endMs}_${c.overlapMs}_${c.continues ? 'c' : 'e'}.wav`;
    await writeFile(path.join(output, filename), Buffer.concat([wavHeader(c.pcm.length), c.pcm]), { flag: 'wx' });
    console.log(filename);
  };
  let offset = 44;
  const buffer = Buffer.alloc(65536);
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    for (const c of chunker.push(buffer.subarray(0,bytesRead))) await save(c);
  }
  const tail = chunker.flush('stop'); if (tail) await save(tail);
} finally { await source.close(); }
