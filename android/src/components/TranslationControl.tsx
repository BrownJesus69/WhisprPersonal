import { useState } from 'react';
import { useAI } from '@/hooks/useAI';
import { translationRuntime } from '@/lib/translation/runtime';
import { UNAVAILABLE, type Target, type TranslationJob } from '@/lib/translation/types';
import type { LocalSession } from '@/lib/db/repositories';
import { LANGUAGES } from '@/types/models';
import { Button } from './Button';
import { Banner } from './Banner';
import { ChipSelect } from './ChipSelect';
import { Toggle } from './BriefOptions';
export function TranslationControl({ session, privacy, target, change, active, job, onSubmitted }: {
  session: LocalSession; privacy?: string; target: Target; change: (value: Target) => void;
  active?: boolean; job?: TranslationJob; onSubmitted?: () => void;
}) {
  const ai = useAI(session.owner_uid,session.event_id);
  const [polish,setPolish] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  if (session.status !== 'finalized') return null;
  const status = ai.status.data;
  const usable = status && (privacy === 'local_only' ? status.local_available : privacy === 'cloud_ai' && (status.local_available || status.cloud_available));
  return <>
    <ChipSelect options={LANGUAGES.map(l => ({ value: l.code, label: l.name }))} selected={[target]} onSelect={change} />
    {usable && <Toggle label="AI-polish the translation" value={polish} change={setPolish} />}
    <Button label="Translate" loading={busy} disabled={!!active} onPress={() => {
      const runner = translationRuntime.get(session.owner_uid);
      if (!runner) { setError(UNAVAILABLE); return; }
      setBusy(true); setError('');
      void runner.submit({ event_id: session.event_id, session_ids: [session.id], target_lang: target, polish: !!usable && polish })
        .then(() => onSubmitted?.()).catch(() => setError(UNAVAILABLE)).finally(() => setBusy(false));
    }} />
    {active && <Banner message={`Translation ${job?.status ?? 'queued'}...`} />}
    {error && <Banner message={error} />}
  </>;
}
