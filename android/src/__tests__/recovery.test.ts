import { recoverSessions, type RecoveryIO } from '@/lib/session/recovery';
import { MemoryRepositories } from '@/lib/db/memoryRepositories';
import { chunkName, parseChunkName } from '@/lib/audio/chunkFiles';
import { session, chunk } from './recordingFixtures';
import type { ChunkSpec } from '@/lib/audio/chunker';

test('parts removed, uploading reset, orphan reinserted from filename', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session({ status: 'stopped', next_sequence: 1, time_ms: 10000 }));
  await repo.insertChunk(chunk(0,{ status: 'uploading' }));
  const spec = { sequence: 1, startMs: 8800, endMs: 20000, overlapMs: 1200, continues: true };
  const files = { removeParts: jest.fn(), listChunkFiles: () => [{ name: chunkName(spec,'a'.repeat(32)), uri: 'orphan.wav' }], parseChunkName,
    hashFile: jest.fn(async () => ({ uri: 'orphan.wav', sizeBytes: 358444, sha256: 'a'.repeat(64) })) } as unknown as RecoveryIO;
  await recoverSessions(repo,'owner',null,files);
  expect(files.removeParts).toHaveBeenCalled();
  expect((await repo.chunks(session().id)).map(c => [c.sequence,c.status])).toEqual([[0,'pending'],[1,'pending']]);
  expect(await repo.session(session().id)).toMatchObject({ next_sequence: 2, time_ms: 20000 });
});
test('interrupted master tail recovers exact overlap and monotone sequences; repeat is idempotent', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session({ next_sequence: 1, time_ms: 10000 })); await repo.insertChunk(chunk());
  const master = Uint8Array.from({ length: 23500 * 32 }, (_,i) => i % 251);
  const saved: ChunkSpec[] = [];
  const files = { removeParts: jest.fn(), listChunkFiles: () => [], parseChunkName, masterExists: () => true,
    readWavPcm: async function* (_uri: string, from: number, to?: number) { yield master.slice(from * 32, to === undefined ? undefined : to * 32); },
    writeChunk: jest.fn(async (_id: string, spec: ChunkSpec) => { saved.push(spec); return { chunkId: `recovered_${spec.sequence}`, uri: 'new.wav', sizeBytes: spec.pcm.length + 44, sha256: 'a'.repeat(64) }; })
  } as unknown as RecoveryIO;
  await recoverSessions(repo,'owner',null,files);
  expect(saved.map(c => [c.sequence,c.startMs,c.endMs,c.overlapMs,c.continues])).toEqual([[1,8800,20000,1200,true],[2,18800,23500,1200,false]]);
  expect(Buffer.from(saved[0].pcm).equals(Buffer.from(master.slice(8800 * 32,20000 * 32)))).toBe(true);
  expect(await repo.session(session().id)).toMatchObject({ status: 'stopped', next_sequence: 3, time_ms: 23500, finalize_status: 'interrupted' });
  await recoverSessions(repo,'owner',null,files); expect(saved).toHaveLength(2);
});
test('unstarted ready and live native sessions are not recovered', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session({ consent_at: null, status: 'paused' }));
  const files = { removeParts: jest.fn(), listChunkFiles: () => [], readWavPcm: jest.fn() } as unknown as RecoveryIO;
  await recoverSessions(repo,'owner',null,files); expect(files.readWavPcm).not.toHaveBeenCalled();
  await repo.updateSession(session().id,{ consent_at: 'today', status: 'recording' });
  await recoverSessions(repo,'owner',session().id,files); expect(files.readWavPcm).not.toHaveBeenCalled();
});

test('a rotated master is read relative to its origin and never borrows prior-run overlap', async () => {
  const repo = new MemoryRepositories();
  const s = session({ master_uri: 'file:///master_10500_abcdef.wav', time_ms: 10500, next_sequence: 2 });
  await repo.putSession(s); await repo.insertChunk(chunk(0)); await repo.insertChunk(chunk(1,{ end_ms: 10500, continues: 0 }));
  const saved: ChunkSpec[] = [];
  const reads: number[] = [];
  const files = { removeParts: jest.fn(), listChunkFiles: () => [], masterExists: () => true,
    readWavPcm: async function* (_uri: string, from: number, to?: number) { reads.push(from); if (to === undefined) yield new Uint8Array(8000); },
    writeChunk: async (_id: string, spec: ChunkSpec) => { saved.push(spec); return { chunkId: 'tail', uri: 'tail.wav', sizeBytes: 8044, sha256: 'a'.repeat(64) }; }
  } as unknown as RecoveryIO;
  await recoverSessions(repo,'owner',null,files);
  expect(reads).toEqual([0,0]); expect(saved[0]).toMatchObject({ sequence: 2, startMs: 10500, endMs: 10750, overlapMs: 0 });
});

test('one unrecoverable recording is skipped with a path-free reason; the others still recover', async () => {
  const repo = new MemoryRepositories();
  const broken = session({ id: 'ses_' + 'b'.repeat(24), next_sequence: 1, time_ms: 10000, master_uri: 'file:///broken.wav' });
  const healthy = session({ id: 'ses_' + 'c'.repeat(24), next_sequence: 1, time_ms: 10000, master_uri: 'file:///healthy.wav' });
  await repo.putSession(broken); await repo.putSession(healthy);
  const master = Uint8Array.from({ length: 12000 * 32 }, (_, i) => i % 251);
  const notify = jest.fn();
  const files = { removeParts: jest.fn(), listChunkFiles: () => [], parseChunkName, masterExists: () => true,
    readWavPcm: async function* (uri: string, from: number, to?: number) {
      if (uri === broken.master_uri) throw new Error('read failed: file:///data/user/0/app/files/master.wav');
      yield master.slice(from * 32, to === undefined ? undefined : to * 32);
    },
    writeChunk: jest.fn(async (_id: string, spec: ChunkSpec) => ({ chunkId: `r_${_id}_${spec.sequence}`, uri: 'new.wav', sizeBytes: spec.pcm.length + 44, sha256: 'a'.repeat(64) }))
  } as unknown as RecoveryIO;
  const result = await recoverSessions(repo, 'owner', null, files, notify);
  expect(result.failed).toEqual(['recovery_failed: read failed: [path]']);
  expect(await repo.session(broken.id)).toMatchObject({ last_error: 'recovery_failed: read failed: [path]' });
  expect(await repo.session(healthy.id)).toMatchObject({ status: 'stopped', finalize_status: 'interrupted' });
  expect(notify).toHaveBeenCalledTimes(1);
});
