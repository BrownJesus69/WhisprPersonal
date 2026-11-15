import { laptopDiagnostics,phoneDiagnostics,diagnosticsText,serverHost } from '../lib/export/diagnostics';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { session,chunk } from './recordingFixtures';
import { note } from './noteFixtures';
import { aiJob } from './aiFixtures';
const sentinel = 'SENSITIVE_SENTINEL';
test('whitelisted laptop fields exclude unknown keys at every level', () => {
  const rows = laptopDiagnostics({ status: 'ok',model: { status: 'ready',secret: sentinel,error: sentinel },gpu: { available: true,credential_path: sentinel },queue: { depth: 4,extra: sentinel },providers: { groq: { status: 'not_configured',key: sentinel } },limits: { max_chunk_upload_bytes: 42,secret: sentinel },config: { secret: sentinel },transcript: sentinel });
  expect(JSON.stringify(rows)).not.toContain(sentinel); expect(rows).toContainEqual({ label: 'queue.depth',value: '4' });
});
test('phone share excludes all content, keys, URL credentials, ids, unknown errors', async () => {
  const repo = new MemoryRepositories(); await repo.putSession(session({ last_error: sentinel }));
  await repo.insertChunk(chunk(0,{ last_error: sentinel })); await repo.putNote(note({ text: sentinel,remote_device: sentinel }));
  await repo.putAIJob(aiJob({ status: 'running' }));
  const rows = await phoneDiagnostics(repo,'owner',{ version: '0.8.0',versionCode: 8,serverUrl: `http://user:${sentinel}@192.168.1.2:8000/path?token=${sentinel}`,passExpiry: 100000,now: 0,network: 'Offline',available: 12,total: 24 });
  const text = diagnosticsText(rows,[]); expect(text).not.toContain(sentinel); expect(text).not.toContain(session().id); expect(text).not.toContain(note().id); expect(text).not.toContain('/path');
  expect(text).toContain('Offline pass until'); expect(text).toContain('AI jobs running: 1'); expect(text).toContain('Notes pending: 1'); expect(text).toContain('other_error');
  expect(serverHost('invalid%%')).toBe('Not set');
});
