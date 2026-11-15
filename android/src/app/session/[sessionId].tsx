import { useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@/components/Button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Screen } from '@/components/Screen';
import { Banner } from '@/components/Banner';
import { Card } from '@/components/Card';
import { ConnectionPill } from '@/components/ConnectionPill';
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
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const client = useQueryClient();
  const t = useTheme();
  const query = useQuery({ queryKey: ['local-session', uid, sessionId], enabled: !!uid, refetchInterval: 2000,
    queryFn: async () => {
      const repo = await repositories();
      const session = await repo.session(sessionId);
      if (!session || session.owner_uid !== uid) throw new Error('Session unavailable');
      return { session, chunks: await repo.chunks(sessionId) };
    }
  });
  const session = query.data?.session;
  const event = useQuery({ queryKey: ['event', uid, session?.event_id], enabled: !!session && !!uid,
    queryFn: () => getEvent(session!.event_id, uid!) });
  const own = recording.sessionId === sessionId;
  const otherLive = !own && ['recording','paused','stopping','requesting_permission','error'].includes(recording.phase) && !!recording.sessionId;
  const recovered = session?.finalize_status === 'interrupted';
  const phase = own ? recording.phase : !session?.consent_at || recovered ? 'ready' : 'stopped';
  const elapsed = own ? recording.elapsedMs : session?.time_ms ?? 0;
  const act = (action: () => Promise<unknown>) => { void action().catch(() => setError('Could not update this session. Please reopen it and try again.')); };
  return <Screen title={event.data?.title ?? 'Recording session'}>
    <ConnectionPill />
    {query.isPending && <Banner message="Loading saved audio…" />}
    {(query.error || error) && <Banner error message={error || 'Could not open this local session.'} />}
    {session && <>
      <Card>
        <Text accessibilityRole="timer" style={{ ...typography.title, color: t.text, fontVariant: ['tabular-nums'] }}>{Math.floor(elapsed / 3600000).toString().padStart(2,'0')}:{Math.floor(elapsed / 60000 % 60).toString().padStart(2,'0')}:{Math.floor(elapsed / 1000 % 60).toString().padStart(2,'0')}</Text>
        <Text style={{ ...typography.body, color: t.muted }}>{own ? recording.phase : !session.consent_at ? 'Ready' : session.status}</Text>
        <LevelMeter dbfs={own ? recording.dbfs : -96} />
      </Card>
      <Banner message="Recording continues with the screen locked. Keep the recording notification visible. Battery restrictions and force stop can interrupt capture." />
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
      <QueueStatus chunks={query.data?.chunks ?? []} offline={['disconnected','error'].includes(connection)} retry={() => act(async () => { await uploadService.retryFailed(sessionId); })} />
      <Card><Text style={{ ...typography.body, color: t.muted }}>Live transcript arrives in the next update</Text></Card>
      <ConsentDialog visible={consent} cancel={() => setConsent(false)} confirm={() => {
        setConsent(false); act(() => recording.start(session, event.data?.title ?? 'Event recording', true));
      }} />
    </>}
  </Screen>;
}
