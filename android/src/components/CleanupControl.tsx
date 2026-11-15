import { useState } from 'react';
import { Text } from 'react-native';
import { useAI } from '@/hooks/useAI';
import { aiRuntime, cleanupResult } from '@/lib/ai/runtime';
import { aiMessage, unavailableReason, UNAVAILABLE } from '@/lib/ai/messages';
import { terminal } from '@/lib/ai/types';
import type { LocalSession } from '@/lib/db/repositories';
import { ServerError } from '@/lib/server/client';
import { useSettingsStore } from '@/state/settingsStore';
import { typography, useTheme } from '@/theme';
import { Button } from './Button';
import { Banner } from './Banner';
import { AIProviderLine } from './AIProviderLine';

export function CleanupControl({ session, privacy }: { session: LocalSession; privacy?: string }) {
  const ai = useAI(session.owner_uid, session.event_id);
  const level = useSettingsStore(s => s.cleanupLevel);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const t = useTheme();
  if (session.status !== 'finalized') return null;
  const job = ai.local.data?.jobs.find(j => j.kind === 'cleanup' && j.session_ids.includes(session.id));
  const active = job && !terminal(job.status);
  const result = job && cleanupResult(job.job_id);
  const reason = level === 'none' ? 'Choose a cleanup level in Settings' : unavailableReason(ai.url, ai.status.data, privacy);
  return <>
    <AIProviderLine status={ai.status.data} />
    <Button label="Clean up" disabled={!!reason || !!active} loading={busy} onPress={() => {
      const runner = aiRuntime.get(session.owner_uid);
      if (!runner || level === 'none') { setError('Reconnect the laptop to start AI requests.'); return; }
      setBusy(true); setError('');
      void runner.submit({ event_id: session.event_id, session_ids: [session.id], level })
        .catch(e => setError(aiMessage(e instanceof ServerError ? e.code : 'unknown'))).finally(() => setBusy(false));
    }} />
    {reason && reason !== UNAVAILABLE && <Text style={{ ...typography.label, color: t.muted }}>{reason}</Text>}
    {active && <Banner message={`Cleanup ${job.status}…`} />}
    {result && <Banner message={`${result.accepted} parts cleaned, ${result.rejected + result.skipped} kept as raw`} />}
    {job && ['failed','interrupted'].includes(job.status) && <Banner message={aiMessage(job.error_code ?? job.status)} />}
    {error && <Banner message={error} />}
  </>;
}
