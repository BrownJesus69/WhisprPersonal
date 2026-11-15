import { composeEventExport, transcriptParts } from '../lib/export/compose';
import { mapEvent } from '../lib/firebase/events';
import { transcriptRow } from '../lib/db/repositories';
import { session } from './recordingFixtures';
import { finalData } from './liveFixtures';
import { note } from './noteFixtures';
import { filterTranscript, sequenceIndex } from '../lib/live/viewer';
const event = mapEvent('event-1',{ ownerId: 'owner', title: 'Caf\u00e9 / Event', location: 'Hall', languages: ['kn'], privacyMode: 'local_only', secret: 'SECRET_SENTINEL' });
const s = session({ next_sequence: 4, expected_chunk_count: 4 });
const row = transcriptRow(s.id,finalData());
const input = { event, sessions: [s], transcripts: [row, { ...row, sequence: 2, no_speech: true, raw_text: 'SILENT' }, { ...row, sequence: 3, failed_code: 'failed' }], notes: [note({ id: 'later', timestamp_ms: 61000, speaker: 'Speaker', source: 'transcript', text: 'later' }),note({ id: 'earlier', timestamp_ms: 1000, text: 'earlier' }),note({ id: 'deleted',deleted: 1,text: 'DELETED' })], now: new Date('2026-11-16T10:00:00Z'), format: 'md' as const, text: 'raw' as const };
test.each(['md','txt'] as const)('composes %s with ordered sections and explicit gaps', format => {
  const d = composeEventExport({ ...input,format,brief: { provider: 'groq', model: 'fixture model', finalText: 'Owner reviewed text' } });
  expect(d.filename).toBe(`whisprpersonal-cafe-event-20261116.${format}`);
  expect(d.content).toContain('[00:00:00] original'); expect(d.content).not.toContain('AI-cleaned text');
  expect(d.content.match(/part not transcribed/g)).toHaveLength(2);
  expect(d.content).toContain('[01:01] Speaker: later (from transcript)');
  expect(d.content.indexOf('earlier')).toBeLessThan(d.content.indexOf('later (from'));
  expect(d.content.indexOf('Owner reviewed text')).toBeLessThan(d.content.indexOf('earlier'));
  expect(d.content.indexOf('later (from')).toBeLessThan(d.content.indexOf('Transcript\n'));
  expect(d.content).toContain('AI-generated brief, reviewed and saved by the owner');
  for (const sentinel of ['SECRET_SENTINEL','SILENT','DELETED',s.master_uri,s.id]) expect(d.content).not.toContain(sentinel);
  if (format === 'txt') expect(d.content).not.toMatch(/^#/m);
});
test('polished export labels fallback without modifying raw', () => {
  const result = composeEventExport({ ...input,text: 'polished' });
  expect(result.content).toContain('AI-cleaned text; the raw transcript is unchanged on the laptop.');
  expect(result.content).toContain('original (not cleaned)'); expect(row.raw_text).toBe('original');
  expect(composeEventExport({ ...input,text: 'polished',transcripts: [{ ...row,polished_text: 'Cleaned' }] }).content).toContain('Cleaned');
});
test.each(['.../\\\u6f22\u5b57','A'.repeat(200),'\u00c9 event'])('filename is bounded and ASCII for %s', title => {
  const d = composeEventExport({ ...input,event: { ...event,title } });
  expect(d.filename.length).toBeLessThanOrEqual(80); expect(d.filename).toMatch(/^[a-z0-9.-]+$/);
});
test('viewer Unicode filter, polished fallback and sequence target use stored rows', () => {
  const parts = transcriptParts(s,[{ ...row,raw_text: '\u0c95\u0ca8\u0ccd\u0ca8\u0ca1 Caf\u00e9' }],'polished');
  expect(parts[0].notCleaned).toBe(true);
  expect(filterTranscript(parts,'\u0c95\u0ca8\u0ccd\u0ca8\u0ca1')).toHaveLength(1);
  expect(filterTranscript(parts,'CAFE\u0301')).toHaveLength(1);
  expect(sequenceIndex(parts,'0')).toBe(0); expect(sequenceIndex(parts,'3')).toBe(3);
  expect(sequenceIndex(parts,'-1')).toBe(-1); expect(sequenceIndex(parts,'900')).toBe(-1);
});


test('exports only deliberate content fields, never credential or device metadata', () => {
  const sentinel = 'SECRET_SENTINEL';
  const document = composeEventExport({ ...input,event: { ...event,server_key: sentinel,token: sentinel,serverUrl: `http://u:${sentinel}@host`,deviceId: sentinel },
    notes: [note({ remote_device: sentinel,remote_json: sentinel,last_error: sentinel })],sessions: [{ ...s,master_uri: sentinel,owner_uid: sentinel }] } as Parameters<typeof composeEventExport>[0]);
  expect(document.content).not.toContain(sentinel);
});
