import { createEvent, getEvent, type SyncErrorHandler } from '@/lib/firebase/events';
import { useSettingsStore } from '@/state/settingsStore';
import { t } from '@/i18n';
import type { EventModel } from '@/types/models';

export function speakEventId(uid: string): string {
  const s = useSettingsStore.getState();
  return s.speakEventIds[uid] || (s.speakEventOwner === uid ? s.speakEventId : '');
}

// Share an in-flight creation so setup and Speak cannot create competing events.
const pending = new Map<string, Promise<EventModel>>();
export function ensureSpeakEvent(uid: string, onSyncError?: SyncErrorHandler): Promise<EventModel> {
  const existing = pending.get(uid);
  if (existing) return existing;
  const work = (async () => {
    const settings = useSettingsStore.getState();
    const id = speakEventId(uid);
    let event = id ? await getEvent(id, uid) : null;
    if (!event) {
      const input = { title: t('speak'), description: '', location: '', startTime: null, endTime: null, agenda: '', speakers: [], languages: [], languageMode: 'auto' as const, privacyMode: settings.privacyMode };
      const created = await createEvent(uid, input, onSyncError);
      event = { ...input, id: created, ownerId: uid, status: 'draft', createdAt: null, updatedAt: null, consentVersion: '' } satisfies EventModel;
    }
    const current = useSettingsStore.getState();
    current.set({ speakEventId: event.id, speakEventOwner: uid, speakEventIds: { ...current.speakEventIds, [uid]: event.id } });
    return event;
  })();
  pending.set(uid, work);
  void work.finally(() => pending.delete(uid)).catch(() => {});
  return work;
}
