import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { kv } from '@/lib/storage/kv';
import type { LanguageMode, PrivacyMode } from '@/types/models';

export interface Settings {
  onboarding: 'pending' | 'done';
  keepTranscripts: boolean;
  reviewBeforeInsert: boolean;
  haptics: boolean;
  keyboardPromptDismissed: boolean;
  appearance: 'system' | 'light' | 'dark';
  recentLanguages: LanguageMode[];
  speakEventIds: Record<string, string>;
  speakEventId: string;
  speakEventOwner: string;
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
  onboarding: 'pending', keepTranscripts: true,
  reviewBeforeInsert: false, haptics: true, keyboardPromptDismissed: false,
  appearance: 'system', recentLanguages: [], speakEventIds: {}, speakEventId: '', speakEventOwner: '',
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
    onboarding: value.onboarding === 'done' || value.onboarding !== 'pending' && typeof value.serverUrl === 'string' && !!value.serverUrl.trim() ? 'done' : 'pending',
    keepTranscripts: s.keepTranscripts !== false,
    reviewBeforeInsert: s.reviewBeforeInsert === true,
    haptics: s.haptics !== false,
    keyboardPromptDismissed: s.keyboardPromptDismissed === true,
    appearance: ['system', 'light', 'dark'].includes(s.appearance) ? s.appearance : 'system',
    recentLanguages: Array.isArray(s.recentLanguages) ? [...new Set(s.recentLanguages.filter(l => ['auto','kn','ta','hi','en'].includes(l)))].slice(0, 3) : [],
    speakEventIds: s.speakEventIds && typeof s.speakEventIds === 'object' && !Array.isArray(s.speakEventIds) ? Object.fromEntries(Object.entries(s.speakEventIds).filter(([, id]) => typeof id === 'string')) : {},
    speakEventId: typeof s.speakEventId === 'string' ? s.speakEventId : '',
    speakEventOwner: typeof s.speakEventOwner === 'string' ? s.speakEventOwner : '',
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
