import { defaults, normalizeSettings, useSettingsStore } from '@/state/settingsStore';
import { kv } from '@/lib/storage/kv';
beforeEach(async () => {
  await useSettingsStore.persist.clearStorage();
  useSettingsStore.setState(defaults);
});

test('safe defaults', () => {
  expect(useSettingsStore.getState()).toMatchObject({
    chunkSeconds: 10,
    overlapMs: 1200,
    cleanupLevel: 'none',
    privacyMode: 'local_only',
    defaultLanguageMode: 'auto',
    audioQuality: 'standard'
  });
});

test('bounds are enforced', () => {
  useSettingsStore.getState().set({ chunkSeconds: 100, overlapMs: 0 });
  expect(useSettingsStore.getState()).toMatchObject({ chunkSeconds: 15, overlapMs: 1000 });
  useSettingsStore.getState().set({ chunkSeconds: 0, overlapMs: 9999 });
  expect(useSettingsStore.getState()).toMatchObject({ chunkSeconds: 5, overlapMs: 1500 });
  expect(normalizeSettings({ chunkSeconds: NaN, overlapMs: Infinity })).toMatchObject({ chunkSeconds: 10, overlapMs: 1200 });
});

test('persistence round trip', async () => {
  useSettingsStore.getState().set({ serverUrl: 'http://192.168.1.20:8000', chunkSeconds: 12 });
  await Promise.resolve();
  const stored = await kv.getItem('whispr.settings');
  expect(stored).toContain('192.168.1.20');
  useSettingsStore.setState(defaults);
  await kv.setItem('whispr.settings', stored!);
  await useSettingsStore.persist.rehydrate();
  expect(useSettingsStore.getState()).toMatchObject({ serverUrl: 'http://192.168.1.20:8000', chunkSeconds: 12 });
});
