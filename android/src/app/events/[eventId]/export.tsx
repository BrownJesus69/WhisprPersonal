import { LANGUAGES } from '@/types/models';
import type { Target } from '@/lib/translation/types';
import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { repositories } from '@/lib/db/repositories';
import { getCachedEvent } from '@/lib/firebase/events';
import { subscribeBriefs, type SavedBrief } from '@/lib/ai/briefs';
import { composeEventExport } from '@/lib/export/compose';
import { shareDocument } from '@/lib/export/share';
import { useAuthStore } from '@/state/authStore';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { ChipSelect } from '@/components/ChipSelect';
import { Toggle } from '@/components/BriefOptions';
import { SectionHeader } from '@/components/SectionHeader';
export default function Export() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>(), uid = useAuthStore(s => s.user?.uid);
  return <ExportContent key={`${uid}:${eventId}`} uid={uid} eventId={eventId} />;
}
function ExportContent({ uid, eventId }: { uid?: string; eventId: string }) {
  const [selection,setSelection] = useState<string[] | null>(null), [format,setFormat] = useState<'md'|'txt'>('md'), [text,setText] = useState<'raw'|'polished'>('raw');
  const [notes,setNotes] = useState(true), [brief,setBrief] = useState<string | null>(null), [remote,setRemote] = useState<SavedBrief[]>([]);
  const [includeTranslation,setIncludeTranslation] = useState(false), [target,setTarget] = useState<Target>('en');
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('');
  const event = useQuery({ queryKey: ['export-event',uid,eventId], enabled: !!uid, queryFn: () => getCachedEvent(eventId,uid!) });
  const local = useQuery({ queryKey: ['export',uid,eventId,target], enabled: !!uid, queryFn: async () => {
    const repo = await repositories(), sessions = (await repo.sessions(uid!)).filter(s => s.event_id === eventId);
    const transcripts = (await Promise.all(sessions.map(s => repo.transcript(s.id)))).flat();
    const translations = (await Promise.all(sessions.map(s => repo.translations(s.id,target)))).flat();
    return { sessions, transcripts, translations, languages: (await Promise.all(sessions.map(s => repo.languageEvents(s.id)))).flat(), notes: await repo.notes(uid!,eventId), briefs: await repo.briefDrafts(uid!,eventId) };
  } });
  useEffect(() => { if (uid && event.data?.ownerId === uid) return subscribeBriefs(eventId,rows => setRemote(rows.filter(b => b.ownerId === uid)),() => {}); }, [uid,eventId,event.data?.ownerId]);
  const selected = selection ?? local.data?.sessions.filter(s => local.data!.transcripts.some(r => r.session_id === s.id)).map(s => s.id) ?? [];
  const briefs = [...remote,...(local.data?.briefs.filter(d => d.status === 'saved' && !remote.some(b => b.id === d.id)).map(d => ({ id: d.id, finalText: d.edited_text, provider: d.provider ?? 'none' as const, model: d.model })) ?? [])];
  return <Screen title="Export">
    {(event.isPending || local.isPending) && <Banner message="Loading saved event data..." />}
    {(event.error || local.error) && <Banner error message="Could not load local export data. Reopen this screen to retry." />}
    <SectionHeader title="Sessions" />
    {local.data?.sessions.map(s => <Toggle key={s.id} checkbox label={new Date(s.created_at).toLocaleString()} value={selected.includes(s.id)} change={v => setSelection(v ? [...selected,s.id] : selected.filter(id => id !== s.id))} />)}
    <ChipSelect options={[{ value: 'md', label: 'Markdown' },{ value: 'txt', label: 'TXT' }]} selected={[format]} onSelect={setFormat} />
    <Button label={'PDF \u2014 not available yet'} disabled onPress={() => {}} />
    <ChipSelect options={[{ value: 'raw', label: 'Raw' },{ value: 'polished', label: 'Cleaned' }]} selected={[text]} onSelect={setText} />
    {text === 'polished' && <Banner message="AI-cleaned text; raw transcript is unchanged on the laptop. Uncleaned parts are labelled." />}
    <Toggle label={`Include translation (${target})`} value={includeTranslation} change={setIncludeTranslation} />
    {includeTranslation && <ChipSelect options={LANGUAGES.map(l => ({ value: l.code, label: l.name }))} selected={[target]} onSelect={setTarget} />}
    <Toggle label="Include notes" value={notes} change={setNotes} />
    <SectionHeader title="Saved brief (optional)" />
    <Button secondary selected={brief === null} label="No brief" onPress={() => setBrief(null)} />
    {briefs.map((b,i) => <Button key={b.id} secondary selected={brief === b.id} label={`Saved brief ${i+1}: ${b.finalText.slice(0,60)}`} onPress={() => setBrief(b.id)} />)}
    {message && <Banner message={message} />}
    <Button label="Export" loading={busy} disabled={!local.data || !event.data || !selected.length} onPress={() => {
      if (!local.data || !event.data) return;
      setBusy(true); setMessage('');
      void shareDocument(composeEventExport({ event: event.data, sessions: local.data.sessions.filter(s => selected.includes(s.id)), transcripts: local.data.transcripts,
        translation: includeTranslation ? { target, rows: local.data.translations } : undefined,
        languageEvents: local.data.languages, notes: notes ? local.data.notes : [], brief: briefs.find(b => b.id === brief), format, text }))
        .then(() => setMessage('Export opened in the share sheet.')).catch(e => setMessage(e instanceof Error && e.message.startsWith('Sharing is not available') ? e.message : 'Could not export. Check phone storage and try again.')).finally(() => setBusy(false));
    }} />
  </Screen>;
}
