import type { Translation, TranslationJob, TranslationStatus } from '../lib/translation/types';
import { session } from './recordingFixtures';
export const translation = (patch: Partial<Translation> = {}): Translation => ({
  session_id: session().id, sequence: 0, source_lang: 'kn', target_lang: 'en', text: 'Translated words',
  engine: 'indictrans2', model: 'fixture-model@revision', created_at: '2026-11-16T10:32:00Z',
  polished_text: null, polish_provider: null, polish_model: null, polished_at: null, error_code: null, ...patch,
});
export const translationJob = (patch: Partial<TranslationJob> = {}): TranslationJob => ({
  job_id: 'translation_one', owner_uid: 'owner', event_id: 'event-1', kind: 'translate',
  session_ids: [session().id], target_lang: 'en', status: 'queued', error_code: null,
  created_at: '2026-11-16T10:32:00Z', updated_at: '2026-11-16T10:32:00Z', ...patch,
});
export const translationStatus = (): TranslationStatus => ({ indictrans2: { en_indic: 'ready_on_disk', indic_en: 'loaded', indic_indic: 'not_downloaded' },
  libretranslate: { 'hi-en': { enabled: false, eligible: true, available: false } }, groq_audio: { configured: false } });
