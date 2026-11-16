import { useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Screen } from '@/components/Screen';
import { TranscriptResult } from '@/components/ui/TranscriptResult';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { repositories, type LocalSession, type TranscriptRow } from '@/lib/db/repositories';
import { removeRecording } from '@/features/speak/retention';
import { useTranscriptDraft } from '@/features/speak/useTranscriptDraft';
import { useAuthStore } from '@/state/authStore';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

export default function HistoryDetail() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>(), uid = useAuthStore(s => s.user?.uid), c = useTheme();
  const [pending, setPending] = useState(false);
  const query = useQuery({ queryKey: ['history-detail', uid, sessionId], enabled: !!uid && !!sessionId && !pending, refetchInterval: pending ? false : 1500, queryFn: async () => {
    const repo = await repositories(), session = await repo.session(sessionId);
    if (!session || session.owner_uid !== uid) return null;
    return { session, rows: (await repo.transcript(sessionId)).sort((a, b) => a.sequence - b.sequence) };
  } });
  return <Screen title={t('transcript')}>
    {pending && <InlineNotice title={t('deletePending')} safety={t('accountNotesKept')} action={t('openHistory')} onPress={() => router.replace('/history')} />}
    {query.error && <InlineNotice title={t('failed')} safety={t('safe')} action={t('retry')} onPress={() => { void query.refetch(); }} />}
    {!pending && (query.data ? <Detail key={`${uid}:${sessionId}`} session={query.data.session} rows={query.data.rows} onPending={() => setPending(true)} /> : !query.isPending && !query.error && <Text style={{ ...typography.body, color: c.muted }}>{t('missingRecording')}</Text>)}
  </Screen>;
}
function Detail({ session, rows, onPending }: { session: LocalSession; rows: TranscriptRow[]; onPending: () => void }) {
  const draft = useTranscriptDraft(session.owner_uid, session.id, rows.map(r => r.raw_text).join(' '), rows.map(r => r.polished_text ?? r.raw_text).join(' '));
  return <>
    {draft.error && <InlineNotice title={t('draftFailed')} safety={t('draftUnsafe')} action={t('retry')} onPress={() => { void draft.flush().catch(() => {}); }} />}
    <TranscriptResult session={session} text={draft.text} edit={draft.edit} cleaned={draft.cleaned} changeCleaned={draft.changeCleaned} flush={draft.flush} hasPolished={rows.some(r => !!r.polished_text)} remove={async () => {
      await draft.flush(); const result = await removeRecording(session.owner_uid, session.id);
      if (result.pending) onPending(); else router.back();
    }} />
  </>;
}
