import type { Timestamp } from '@react-native-firebase/firestore';

export const LANGUAGES = [{ code: 'kn', name: 'Kannada' }, { code: 'ta', name: 'Tamil' }, { code: 'hi', name: 'Hindi' }, { code: 'en', name: 'English' }] as const;
/** Language choices for an event or recording: Auto plus each supported language. */
export const LANGUAGE_MODE_OPTIONS: { value: LanguageMode; label: string }[] = [{ value: 'auto', label: 'Auto' }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))];

export type LanguageCode = typeof LANGUAGES[number]['code'];

export type LanguageMode = 'auto' | LanguageCode;

export type PrivacyMode = 'local_only' | 'cloud_ai';

export const EVENT_STATUSES = ['draft', 'active', 'processing', 'completed', 'failed'] as const;

export type EventStatus = typeof EVENT_STATUSES[number];

export interface EventModel {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  location: string;
  startTime: Timestamp | null;
  endTime: Timestamp | null;
  agenda: string;
  speakers: string[];
  languages: LanguageCode[];
  languageMode: LanguageMode;
  status: EventStatus;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  consentVersion: string;
  privacyMode: PrivacyMode;
}

export type EventInput = Pick<EventModel, 'title' | 'description' | 'location' | 'startTime' | 'endTime' | 'agenda' | 'speakers' | 'languages' | 'languageMode' | 'privacyMode'>;
