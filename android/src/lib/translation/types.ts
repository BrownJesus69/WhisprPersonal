import type { AIJob, JobStatus } from '../ai/types';
export const TARGETS = ['en', 'kn', 'ta', 'hi'] as const;
export type Target = typeof TARGETS[number];
export const ENGINES = ['indictrans2', 'libretranslate', 'groq-audio-translation'] as const;
export type Engine = typeof ENGINES[number];
export interface Translation {
  session_id: string; sequence: number; target_lang: Target; source_lang: string; text: string | null;
  engine: Engine | null; model: string | null; created_at: string; polished_text: string | null;
  polish_provider: 'groq' | 'sambanova' | 'local_llm' | null; polish_model: string | null;
  polished_at: string | null; error_code: string | null;
}
export interface TranslateRequest { event_id: string; session_ids: string[]; target_lang: Target; polish: boolean }
export interface TranslationJob extends Omit<AIJob, 'kind'> { kind: 'translate'; target_lang: Target }
export interface TranslationJobResponse {
  job_id: string; status: JobStatus; error_code: string | null;
  result: { translated: number; skipped: number; failed: number } | null;
}
export const DIRECTIONS = ['en_indic', 'indic_en', 'indic_indic'] as const;
export const ENGINE_STATES = ['not_checked', 'not_configured', 'not_downloaded', 'ready_on_disk', 'loaded', 'error', 'unavailable'] as const;
export interface TranslationStatus {
  indictrans2: Record<typeof DIRECTIONS[number], typeof ENGINE_STATES[number]>;
  libretranslate: Record<string, { enabled: boolean; eligible: boolean; available: boolean }>;
  groq_audio: { configured: boolean };
}
export const UNAVAILABLE = 'Translation unavailable; showing the original transcript.';
