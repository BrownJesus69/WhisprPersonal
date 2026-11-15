import type { EventModel } from '@/types/models';
import { LANGUAGES } from '@/types/models';
import type { LocalSession, TranscriptRow, LanguageEventRow } from '../db/repositories';
import type { Note } from '../notes/model';
import type { SavedBrief } from '../ai/briefs';
export interface ExportDocument { filename: string; mimeType: string; content: string }
export const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
};
export const languageName = (code: string) => LANGUAGES.find(l => l.code === code)?.name ?? code;
export function transcriptParts(session: LocalSession, rows: TranscriptRow[], text: 'raw' | 'polished') {
  const saved = new Map(rows.filter(r => r.session_id === session.id).map(r => [r.sequence,r]));
  const count = [...saved.keys()].reduce((max,n) => Math.max(max,n+1), Math.max(session.expected_chunk_count ?? 0,session.next_sequence));
  return Array.from({ length: count }, (_, sequence) => {
    const r = saved.get(sequence);
    if (r?.no_speech && !r.failed_code) return null;
    const failed = !r || !!r.failed_code;
    return { sequence, startMs: r?.start_ms ?? sequence * session.chunk_ms,
      text: failed ? '[part not transcribed]' : text === 'polished' ? r.polished_text ?? r.raw_text : r.raw_text,
      notCleaned: !failed && text === 'polished' && r.polished_text == null,
      failed: failed ? 'not_transcribed' : undefined, revision: r?.revision ?? 0, language: r?.detected_language };
  }).filter(r => r !== null);
}
export function composeEventExport(input: {
  event: EventModel; sessions: LocalSession[]; transcripts: TranscriptRow[]; languageEvents?: LanguageEventRow[];
  notes: Note[]; brief?: Pick<SavedBrief, 'finalText' | 'provider' | 'model'>; format: 'md' | 'txt'; text: 'raw' | 'polished'; now?: Date;
}): ExportDocument {
  const { event, format, text } = input, now = input.now ?? new Date();
  const heading = (level: number, title: string) => `${format === 'md' ? '#'.repeat(level) + ' ' : ''}${title}`;
  const lines = [heading(1,event.title), `Date/time: ${event.startTime?.toDate().toISOString() ?? 'Not set'}`,
    `Location: ${event.location || 'Not set'}`, `Languages: ${event.languages.map(languageName).join(', ') || 'Auto'}`,
    `Privacy mode: ${event.privacyMode}`, `Exported UTC: ${now.toISOString()}`, ''];
  if (text === 'polished') lines.push('AI-cleaned text; the raw transcript is unchanged on the laptop.', '');
  if (input.brief) lines.push(heading(2,'Brief'), 'AI-generated brief, reviewed and saved by the owner',
    `Provider: ${input.brief.provider}; model: ${input.brief.model ?? 'Not supplied'}`,input.brief.finalText,'');
  lines.push(heading(2,'Notes'));
  for (const n of input.notes.filter(n => !n.deleted && n.event_id === event.id).sort((a,b) => (a.timestamp_ms ?? 0) - (b.timestamp_ms ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const ms = n.timestamp_ms ?? 0;
    const time = `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}`;
    lines.push(`[${time}] ${n.speaker ? n.speaker + ': ' : ''}${n.text}${n.source === 'transcript' ? ' (from transcript)' : ''}`);
  }
  lines.push('',heading(2,'Transcript'));
  for (const s of input.sessions.filter(s => s.event_id === event.id)) {
    lines.push(heading(3,`Session ${s.created_at}`),`Duration: ${clock(s.time_ms)}`,`Transcript status: ${s.finalize_status ?? s.status}`, '');
    let previous: string | null | undefined;
    for (const r of transcriptParts(s,input.transcripts,text)) {
      const language = r.language ?? input.languageEvents?.filter(e => e.session_id === s.id && e.at_sequence !== null && e.at_sequence <= r.sequence).at(-1)?.language;
      if (language && language !== previous) { lines.push(`\u2014 ${languageName(language)} \u2014`); previous = language; }
      lines.push(`[${clock(r.startMs)}] ${r.text}${r.notCleaned ? ' (not cleaned)' : ''}`);
    }
    lines.push('');
  }
  const slug = event.title.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'event';
  const suffix = `-${now.toISOString().slice(0,10).replace(/-/g,'')}.${format}`;
  const prefix = 'whisprpersonal-';
  return { filename: prefix + slug.slice(0,80-prefix.length-suffix.length).replace(/-$/,'') + suffix,
    mimeType: format === 'md' ? 'text/markdown' : 'text/plain', content: lines.join('\n') };
}
