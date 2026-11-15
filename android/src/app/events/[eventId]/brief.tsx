import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/state/authStore';
import { repositories } from '@/lib/db/repositories';
import { getEvent } from '@/lib/firebase/events';
import { aiRuntime } from '@/lib/ai/runtime';
import { saveBrief, subscribeBriefs, type SavedBrief } from '@/lib/ai/briefs';
import { aiMessage, providerName, unavailableReason, UNAVAILABLE } from '@/lib/ai/messages';
import { terminal, type BriefDraft, type BriefType } from '@/lib/ai/types';
import { ServerError } from '@/lib/server/client';
import { useAI } from '@/hooks/useAI';
import { useTheme, typography } from '@/theme';
import { Screen } from '@/components/Screen';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { Banner } from '@/components/Banner';
import { BriefEditor } from '@/components/BriefEditor';
import { BriefTypeChips, Toggle } from '@/components/BriefOptions';
import { AIProviderLine } from '@/components/AIProviderLine';

export default function BriefScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const uid = useAuthStore(s => s.user?.uid);
  return <BriefContent key={`${uid}:${eventId}`} uid={uid} eventId={eventId} />;
}
function BriefContent({ uid, eventId }: { uid?: string; eventId: string }) {
  const ai = useAI(uid, eventId), t = useTheme();
  const [selection, setSelection] = useState<string[] | null>(null);
  const [type, setType] = useState<BriefType>('summary');
  const [notes, setNotes] = useState(true), [polished, setPolished] = useState(false), [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [remote, setRemote] = useState<SavedBrief[]>([]), [cached, setCached] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const event = useQuery({ queryKey: ['event', uid, eventId], enabled: !!uid, queryFn: () => getEvent(eventId, uid!) });
  const sessions = useQuery({ queryKey: ['brief-sessions', uid, eventId], enabled: !!uid, refetchInterval: 3000,
    queryFn: async () => (await (await repositories()).sessions(uid!)).filter(s => s.event_id === eventId && s.status === 'finalized') });
  useEffect(() => {
    if (!uid || event.data?.ownerId !== uid) return;
    return subscribeBriefs(eventId, (rows, fromCache) => { setRemote(rows.filter(b => b.ownerId === uid)); setCached(fromCache); }, () => setError('Saved briefs could not sync. Local drafts remain available.'));
  }, [uid, eventId, event.data?.ownerId]);
  const selected = selection ?? sessions.data?.map(s => s.id) ?? [];
  const chosen = sessions.data?.filter(s => selected.includes(s.id)) ?? [];
  const incomplete = chosen.some(s => s.finalize_status !== 'complete');
  const active = ai.local.data?.jobs.find(j => !terminal(j.status));
  const last = ai.local.data?.jobs.find(j => j.kind === 'brief');
  const reason = unavailableReason(ai.url, ai.status.data, event.data?.privacyMode);
  const refresh = async () => { await ai.local.refetch(); };
  const assertOwner = () => { if (!uid || useAuthStore.getState().user?.uid !== uid) throw new Error('Account changed'); return uid; };
  const save = async (draft: BriefDraft) => {
    await saveBrief(assertOwner(), draft, () => setError('Cloud save was rejected. The saved copy stays on this phone; reconnect and retry.' ));
    await refresh();
  };
  const saved = [...remote.map(b => ({ id: b.id, title: b.type.replaceAll('_',' '), text: b.finalText, provider: b.provider, model: b.model, incomplete: b.incomplete })),
    ...(ai.local.data?.drafts.filter(d => d.status === 'saved' && !remote.some(b => b.id === d.id)).map(d => ({ id: d.id, title: d.brief_type.replaceAll('_',' '), text: d.edited_text, provider: d.provider, model: d.model, incomplete: !!d.incomplete })) ?? [])];
  return <Screen title="Brief generator">
    <Banner message="AI-generated briefs are separate from your raw transcript. Review before saving." />
    {error && <Banner message={error} />}
    {(sessions.error || ai.local.error) && <Banner error message="Could not read local sessions or drafts. Reopen this screen to retry." />}
    <Card>
      <Text accessibilityRole="header" style={{ ...typography.title, color: t.text }}>Choose sessions</Text>
      {!sessions.data?.length && <Banner message="Finalize a session to generate a brief." />}
      {sessions.data?.map(s => <Toggle key={s.id} checkbox label={new Date(s.created_at).toLocaleString()} value={selected.includes(s.id)} change={value => {
        setSelection(value ? [...selected,s.id] : selected.filter(id => id !== s.id)); setAllow(false);
      }} />)}
      {selected.length > 20 && <Banner message="Choose up to 20 sessions." />}
      <BriefTypeChips value={type} change={setType} />
      <Toggle label="Include my notes" value={notes} change={setNotes} />
      <Toggle label="Use cleaned text where available" value={polished} change={setPolished} />
      {incomplete && <>
        <Banner message="Some selected transcripts are incomplete or their completeness is unknown. The brief may miss speech." />
        <Toggle checkbox label="Generate from incomplete transcript" value={allow} change={setAllow} />
      </>}
      <AIProviderLine status={ai.status.data} />
      {reason && reason !== UNAVAILABLE && <Banner message={reason} />}
      <Button secondary label="Refresh providers" disabled={!ai.url} onPress={() => { void ai.status.refetch(); }} />
      <Button label="Generate" loading={busy} disabled={!!reason || !chosen.length || selected.length > 20 || (incomplete && !allow) || !!active} onPress={() => {
        const owner = assertOwner(), runner = aiRuntime.get(owner);
        if (!runner) { setError('Reconnect the laptop to start AI requests.'); return; }
        setBusy(true); setError('');
        void repositories().then(async repo => {
          const localNotes = notes ? (await repo.notes(owner,eventId)).filter(n => !n.deleted).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,200) : [];
          assertOwner();
          await runner.submit({ event_id: eventId, session_ids: chosen.map(s => s.id), brief_type: type,
            allow_incomplete: incomplete && allow, use_polished: polished,
            notes: localNotes.map(n => ({ text: n.text, timestamp_ms: n.timestamp_ms, speaker: n.speaker })) });
          await refresh();
        }).catch(e => setError(aiMessage(e instanceof ServerError ? e.code : 'unknown'))).finally(() => setBusy(false));
      }} />
      {active && <Banner message={`AI request ${active.status}… You can leave this screen.`} />}
      {last && ['failed','interrupted'].includes(last.status) && <Banner message={aiMessage(last.error_code ?? last.status)} />}
    </Card>
    {ai.local.data?.drafts.filter(d => d.status === 'draft').map(d => <BriefEditor key={d.id} draft={d}
      persist={async value => { assertOwner(); await (await repositories()).putBriefDraft(value); }} save={save}
      discard={async () => { await (await repositories()).deleteBriefDraft(assertOwner(),d.id); await refresh(); }} />)}
    <Text accessibilityRole="header" style={{ ...typography.title, color: t.text }}>Saved briefs{cached ? ' · offline cache' : ''}</Text>
    {!saved.length && <Text style={{ ...typography.body, color: t.muted }}>No saved briefs yet.</Text>}
    {saved.map(b => <Card key={b.id}>
      <Button secondary label={b.title} onPress={() => setView(view === b.id ? null : b.id)} />
      {view === b.id && <>
        <Text style={{ ...typography.label, color: t.primary }}>Generated by {providerName(b.provider)}{b.model ? ` · ${b.model}` : ''}</Text>
        <Banner message="AI-generated — check it against the transcript" />
        {b.incomplete && <Banner message="Generated from an incomplete transcript." />}
        <Text selectable style={{ ...typography.body, color: t.text }}>{b.text}</Text>
        {ai.local.data?.drafts.some(d => d.id === b.id && d.status === 'saved') && <Button secondary label="Retry cloud save" onPress={() => {
          const local = ai.local.data?.drafts.find(d => d.id === b.id);
          if (local) void save(local).catch(() => setError('Could not queue the cloud save. The phone copy is preserved.'));
        }} />}
        <Button secondary label="Close brief" onPress={() => setView(null)} />
      </>}
    </Card>)}
  </Screen>;
}
