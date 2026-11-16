import { TranslationControl } from '@/components/TranslationControl';
import { TranslationList } from '@/components/TranslationList';
import { useTranslation } from '@/hooks/useTranslation';
import { deleteSession, LaptopUnavailable } from '@/lib/session/deleteSession';
import { deleteAudio, listChunkFiles, removeParts } from '@/lib/audio/chunkFiles';
import { authedClient } from '@/lib/server/authedClient';
import { aiRuntime } from '@/lib/ai/runtime';
import { CleanupControl } from '@/components/CleanupControl';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Text, ToastAndroid, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { QuickNote } from '@/components/QuickNote';
import { createNote } from '@/lib/notes/notes';
import { noteSync } from '@/lib/notes/noteSync';
import { Button } from '@/components/Button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Card } from '@/components/Card';
import { Collapsible } from '@/components/Collapsible';
import { LiveStatusPill } from '@/components/LiveStatusPill';
import { LanguageBadge, languageName } from '@/components/LanguageBadge';
import { LanguagePicker } from '@/components/LanguagePicker';
import { TranscriptTabs } from '@/components/TranscriptTabs';
import { TranscriptList } from '@/components/TranscriptList';
import { liveController } from '@/lib/live/liveController';
import { emptyView, useTranscriptStore } from '@/lib/live/transcriptStore';
import { ConsentDialog } from '@/components/ConsentDialog';
import { LevelMeter } from '@/components/LevelMeter';
import { QueueStatus } from '@/components/QueueStatus';
import { RecordControls } from '@/components/RecordControls';
import { repositories } from '@/lib/db/repositories';
import { useRecordingStore } from '@/lib/session/recordingStore';
import { uploadService } from '@/lib/upload/uploadService';
import { getEvent, updateEventStatus } from '@/lib/firebase/events';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { useTheme, typography } from '@/theme';

export default function SessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const uid = useAuthStore(s => s.user?.uid);
  const connection = useConnectionStore(s => s.status);
  const recording = useRecordingStore();
  const [deleting,setDeleting] = useState(false);
  const [tab, setTab] = useState<'raw' | 'polished' | 'translation'>('raw');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const client = useQueryClient();
  const t = useTheme();
  const query = useQuery({ queryKey: ['local-session', uid, sessionId], enabled: !!uid, refetchInterval: 2000,
    queryFn: async () => {
      const repo = await repositories();
      const session = await repo.session(sessionId);
      if (!session || session.owner_uid !== uid) throw new Error('Session unavailable');
      return { session, chunks: await repo.chunks(sessionId), transcript: await repo.transcript(sessionId) };
    }
  });
  const session = query.data?.session;
  const translation = useTranslation(session);
  const live = useTranscriptStore(s => s.sessions[sessionId] ?? emptyView);
  useEffect(() => { if (session?.owner_uid === uid) return liveController.acquire(sessionId); }, [session?.owner_uid, sessionId, uid]);
  const event = useQuery({ queryKey: ['event', uid, session?.event_id], enabled: !!session && !!uid,
    queryFn: () => getEvent(session!.event_id, uid!) });
  // Depend on ids only: the session row changes with every saved chunk, and resubscribing
  // would re-read the event's notes from Firestore each time.
  const watchEventId = session && session.owner_uid === uid ? session.event_id : undefined;
  useEffect(() => { if (watchEventId) return noteSync.watch(watchEventId); }, [watchEventId]);
  const own = recording.sessionId === sessionId;
  const otherLive = !own && ['recording','paused','stopping','requesting_permission','error'].includes(recording.phase) && !!recording.sessionId;
  const recovered = session?.finalize_status === 'interrupted';
  const phase = own ? recording.phase : !session?.consent_at || recovered ? 'ready' : 'stopped';
  const elapsed = own ? recording.elapsedMs : session?.time_ms ?? 0;
  const act = (action: () => Promise<unknown>) => { void action().catch(() => setError('Could not update this session. Please reopen it and try again.')); };
  const removeSession = async (phoneOnly = false) => {
    if (!uid) return;
    setDeleting(true);
    try {
      await uploadService.stop(); await aiRuntime.stop(); liveController.stopRuntime();
      const state = useRecordingStore.getState();
      await deleteSession({ repo: await repositories(), client: authedClient(uid), owner: uid, id: sessionId,
        activeId: state.sessionId, phase: state.phase, phoneOnly, removeFile: deleteAudio,
        removeOrphans: id => { for (const f of listChunkFiles(id)) f.delete(); removeParts(id); } });
      await client.invalidateQueries({ queryKey: ['local-sessions',uid] }); router.back();
    } catch (e) {
      if (e instanceof LaptopUnavailable) Alert.alert('Delete on this phone only?', 'The laptop copy remains. Its deletion is queued and retried automatically when the upload service reconnects. Event notes are kept. Phone deletion cannot be undone.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Delete on this phone only', style: 'destructive', onPress: () => { void removeSession(true); } }
      ]);
      else setError(e instanceof Error ? e.message : 'Could not delete this session. Try again.');
    } finally {
      setDeleting(false); liveController.startRuntime();
      if (useAuthStore.getState().user?.uid === uid) { void uploadService.start(uid); void aiRuntime.start(uid); }
    }
  };
  return <Screen scroll={false} title={event.data?.title ?? 'Recording session'}>
    {query.isPending && <Banner message="Loading saved audio…" />}
    {(query.error || error) && <Banner error message={error || 'Could not open this local session.'} />}
    {session && <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <LiveStatusPill status={live.status} attempt={live.attempt} />
        <LanguageBadge language={live.model.language} />
      </View>
      <ScrollView style={{ maxHeight: '45%' }} contentContainerStyle={{ gap: 8 }}>
      <Card>
        <Text accessibilityRole="timer" style={{ ...typography.title, color: t.text, fontVariant: ['tabular-nums'] }}>{Math.floor(elapsed / 3600000).toString().padStart(2,'0')}:{Math.floor(elapsed / 60000 % 60).toString().padStart(2,'0')}:{Math.floor(elapsed / 1000 % 60).toString().padStart(2,'0')}</Text>
        <Text style={{ ...typography.body, color: t.muted }}>{(own ? recording.phase : !session.consent_at ? 'Ready' : session.status).replaceAll('_', ' ').replace(/^./, c => c.toUpperCase())}</Text>
        <LevelMeter dbfs={own ? recording.dbfs : -96} />
      </Card>
      {phase === 'ready' && !recovered && <Banner message="Recording keeps going with the screen locked. Don't swipe away the recording notification." />}
      {recovered && <Banner message="Recording was interrupted. Saved audio was recovered. Resume recording or finish this session." />}
      {own && recording.message && <Banner error={recording.phase === 'error'} message={recording.message} />}
      {own && recording.warning && <Banner message={recording.warning} />}
      {session.last_error && !recovered && <Banner error message={`Session: ${session.last_error}`} />}
      {otherLive ? <>
        <Banner message="Another session needs attention. Stop it before starting this one." />
        <Button label="Open current session" onPress={() => router.push({ pathname: '/session/[sessionId]', params: { sessionId: recording.sessionId! } })} />
      </> : <RecordControls
        phase={phase} busy={own && recording.busy} recovered={recovered}
        start={() => setConsent(true)} pause={() => act(recording.pause)} resume={() => act(recording.resume)}
        stop={() => act(async () => {
          if (recovered && !own) {
            await (await repositories()).updateSession(sessionId, { status: 'stopped', finalize_status: null, last_error: null });
            updateEventStatus(session.event_id, 'processing'); uploadService.notify();
          } else await recording.stop();
          await client.invalidateQueries({ queryKey: ['local-session', uid, sessionId] });
        })}
      />}
      <QuickNote eventId={session.event_id} sessionId={sessionId} phase={phase} elapsedMs={elapsed} />
      <QueueStatus chunks={query.data?.chunks ?? []} offline={['disconnected','error'].includes(connection)} retry={() => act(async () => { await uploadService.retryFailed(sessionId); })} />
      <Collapsible title="More options">
        {!['stopped', 'finalized'].includes(session.status) && <LanguagePicker mode={live.model.language.mode} onSelect={mode => act(async () => {
          await liveController.setOverride(sessionId, mode);
          if (Platform.OS === 'android') ToastAndroid.show('Applies from the next chunk', ToastAndroid.SHORT);
        })} />}
        <CleanupControl session={session} privacy={event.data?.privacyMode} />
        <TranslationControl session={session} privacy={event.data?.privacyMode} target={translation.target} change={translation.setTarget} active={translation.active} job={translation.job} onSubmitted={() => setTab('translation')} />
        <Button secondary label="Delete session" loading={deleting} disabled={own && ['recording','paused','stopping','requesting_permission','error'].includes(recording.phase)} onPress={() => Alert.alert('Delete session?', 'Deletes session audio and transcript from this phone and the laptop. This cannot be undone. Event notes and saved briefs are kept.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Delete session', style: 'destructive', onPress: () => { void removeSession(); } }
        ])} />
      </Collapsible>
      {translation.message && <Banner message={translation.message} />}
      </ScrollView>
      <TranscriptTabs translation={session.status === 'finalized'} selected={tab} onSelect={setTab} />
      {!!live.model.language.timeline.length && <ScrollView horizontal style={{ flexGrow: 0 }} accessibilityLabel="Language timeline">
        <Text selectable style={{ ...typography.label, color: t.muted }}>{live.model.language.timeline.map(s => `${languageName(s.language)} (${s.fromSequence + 1}–${s.toSequence + 1})`).join(' → ')}</Text>
      </ScrollView>}
      {tab === 'translation' ? <TranslationList session={session} originals={query.data?.transcript ?? []} rows={translation.rows} target={translation.target} /> : <TranscriptList polished={tab === 'polished'} stored={query.data?.transcript} onAddNote={row => act(async () => {
        await createNote(session.event_id, { text: row.text, source: 'transcript', timestampMs: row.startMs, sessionId, sequence: row.sequence, language: row.language ?? null });
        if (Platform.OS === 'android') ToastAndroid.show('Added to notes', ToastAndroid.SHORT);
      })} model={live.model} chunkStarts={Object.fromEntries((query.data?.chunks ?? []).map(c => [c.sequence, c.start_ms]))} />}
      <ConsentDialog visible={consent} cancel={() => setConsent(false)} confirm={() => {
        setConsent(false); act(() => recording.start(session, event.data?.title ?? 'Event recording', true));
      }} />
    </>}
  </Screen>;
}
