import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kv } from '@/lib/storage/kv';
import type { LanguageMode, PrivacyMode } from '@/types/models';

export interface Settings {
  serverUrl: string;
  defaultLanguageMode: LanguageMode;
  audioQuality: 'low' | 'standard' | 'high';
  cleanupLevel: 'none' | 'conservative' | 'polished';
  privacyMode: PrivacyMode;
  chunkSeconds: number;
  overlapMs: number;
  deleteLocalAudioAfterTranscription: boolean;
}

export const defaults: Settings = {
  serverUrl: '',
  defaultLanguageMode: 'auto',
  audioQuality: 'standard',
  cleanupLevel: 'none',
  privacyMode: 'local_only',
  chunkSeconds: 10,
  overlapMs: 1200,
  deleteLocalAudioAfterTranscription: false
};

export function normalizeSettings(value: Partial<Settings>): Settings {
  const s = { ...defaults, ...value };
  return {
    serverUrl: typeof s.serverUrl === 'string' ? s.serverUrl : '',
    defaultLanguageMode: ['auto', 'kn', 'ta', 'hi', 'en'].includes(s.defaultLanguageMode) ? s.defaultLanguageMode : 'auto',
    audioQuality: ['low', 'standard', 'high'].includes(s.audioQuality) ? s.audioQuality : 'standard',
    cleanupLevel: ['none', 'conservative', 'polished'].includes(s.cleanupLevel) ? s.cleanupLevel : 'none',
    privacyMode: s.privacyMode === 'cloud_ai' ? 'cloud_ai' : 'local_only',
    chunkSeconds: Number.isFinite(s.chunkSeconds) ? Math.max(5, Math.min(15, s.chunkSeconds)) : 10,
    overlapMs: Number.isFinite(s.overlapMs) ? Math.max(1000, Math.min(1500, s.overlapMs)) : 1200,
    deleteLocalAudioAfterTranscription: s.deleteLocalAudioAfterTranscription === true
  };
}

export const useSettingsStore = create<Settings & {
  set: (value: Partial<Settings>) => void;
}>()(persist((set) => ({ ...defaults, set: (value) => set(state => normalizeSettings({ ...state, ...value })) }), {
  name: 'whispr.settings',
  skipHydration: true,
  storage: createJSONStorage(() => kv),
  merge: (saved, current) => ({ ...current, ...normalizeSettings(saved as Partial<Settings>) })
}));
