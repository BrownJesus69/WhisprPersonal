import { useState } from 'react';
import type { LocalSession, TranscriptRow } from '@/lib/db/repositories';
import { recognitionProblem } from '@/features/speak/recovery';
import { uploadService } from '@/lib/upload/uploadService';
import { withDeadline } from '@/lib/deadline';
import { t } from '@/i18n';
import { InlineNotice } from './InlineNotice';
export function RecognitionNotice({ session, rows, again }: { session: LocalSession | null; rows: TranscriptRow[]; again: () => void }) {
  const [retryError, setRetryError] = useState(false), [busy, setBusy] = useState(false);
  const problem = recognitionProblem(session, rows);
  if (!problem) return null;
  return <InlineNotice busy={busy} title={t(retryError ? 'retryUploadFailed' : problem)} safety={t(problem === 'noSpeech' ? 'keptHistory' : session?.master_uri && session.consent_at ? 'recognitionAudioSafe' : 'connectionSafety')} action={t('retry')} onPress={() => {
    if (problem === 'noSpeech') { again(); return; }
    setRetryError(false);
    const work = uploadService.retryFailed(session!.id);
    if (!work) { setRetryError(true); return; }
    setBusy(true);
    void withDeadline(work).catch(() => setRetryError(true)).finally(() => setBusy(false));
  }} />;
}
