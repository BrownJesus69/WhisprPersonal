import keyboard from '../../../modules/whispr-keyboard';
import { useSettingsStore } from '@/state/settingsStore';
import { useAuthStore } from '@/state/authStore';
import { credentials } from '@/lib/server/credentials';
import { parseServerUrl } from '@/lib/server/serverUrl';
import { speakEventId } from '@/features/speak/speakEvent';

// Serialize native writes and invalidate work awaiting secure storage on account changes.
let revision = 0;
let pending: Promise<void> = Promise.resolve();
export function syncKeyboard(): Promise<void> {
  const currentRevision = ++revision;
  const work = pending.catch(() => {}).then(async () => {
    if (currentRevision !== revision) return;
    const auth = useAuthStore.getState();
    const settings = useSettingsStore.getState();
    if (auth.status !== 'signed_in' || !auth.user || !settings.serverUrl) {
      await keyboard.clearConfig(); return;
    }
    try {
      const serverKey = await credentials.getServerKey();
      if (currentRevision !== revision || useAuthStore.getState().user?.uid !== auth.user.uid) return;
      if (!serverKey) { await keyboard.clearConfig(); return; }
      await keyboard.setConfig({ serverUrl: parseServerUrl(settings.serverUrl).url, serverKey,
        languageMode: settings.defaultLanguageMode, reviewBeforeInsert: settings.reviewBeforeInsert,
        haptics: settings.haptics, speakEventId: speakEventId(auth.user.uid) });
    } catch {
      await keyboard.clearConfig();
      throw new Error('Keyboard configuration could not be saved');
    }
  });
  pending = work;
  return work;
}
export function clearKeyboardConfig(): Promise<void> {
  ++revision;
  const work = pending.catch(() => {}).then(() => keyboard.clearConfig());
  pending = work;
  return work;
}
export function startKeyboardSync(onError: () => void): () => void {
  const sync = () => { void syncKeyboard().catch(onError); };
  const settings = useSettingsStore.subscribe((state, old) => {
    if (state.serverUrl !== old.serverUrl || state.defaultLanguageMode !== old.defaultLanguageMode ||
        state.reviewBeforeInsert !== old.reviewBeforeInsert || state.haptics !== old.haptics ||
        state.speakEventIds !== old.speakEventIds || state.speakEventId !== old.speakEventId ||
        state.speakEventOwner !== old.speakEventOwner) sync();
  });
  const auth = useAuthStore.subscribe((state, old) => { if (state.user?.uid !== old.user?.uid || state.status !== old.status) sync(); });
  sync();
  return () => { settings(); auth(); };
}
