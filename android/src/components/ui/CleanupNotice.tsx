import { useRef, useState } from 'react';
import type { LocalSession } from '@/lib/db/repositories';
import { requestDefaultCleanup } from '@/features/speak/defaultCleanup';
import { useSettingsStore } from '@/state/settingsStore';
import { withDeadline } from '@/lib/deadline';
import { t } from '@/i18n';
import { InlineNotice } from './InlineNotice';

export function CleanupNotice({ session }: { session: LocalSession }) {
  const pending = useRef(false), [busy, setBusy] = useState(false), [unavailable, setUnavailable] = useState(false);
  return <InlineNotice busy={busy} title={t(unavailable ? 'notSetUpComputer' : 'cleanupFailed')} safety={t('originalSafe')} action={t('retry')} onPress={() => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const level = useSettingsStore.getState().cleanupLevel;
    void withDeadline(requestDefaultCleanup(session.owner_uid, session.id, level === 'none' ? 'conservative' : level, true))
      .then(result => setUnavailable(result === 'not_configured')).catch(() => setUnavailable(false))
      .finally(() => { pending.current = false; setBusy(false); });
  }} />;
}
