import { t } from '@/i18n';
import type { AIStatus } from './types';

export const UNAVAILABLE = 'Cloud AI unavailable; raw transcript preserved.';
export const AI_MESSAGES: Record<string, string> = {
  provider_unavailable: UNAVAILABLE,
  cloud_ai_disabled_for_event: 'Cloud AI is off for this event',
  privacy_mode_unknown: 'Could not confirm event privacy. Try again when connected.',
  transcript_incomplete: 'The transcript is incomplete. Review it before generating.',
  transcript_too_long: 'Select fewer sessions and try again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  queue_full: 'The laptop is busy. Try again shortly.',
  not_found: 'This request is no longer on the laptop. Request it again.',
  job_timeout: 'This request took too long. Try again.',
  ai_output_invalid: 'The AI output could not be checked. Raw text is preserved.',
  interrupted: 'The laptop restarted; request it again.',
  bad_response: 'The laptop sent an unreadable response. Try again.',
  renew_required: 'Sign in to the recording account and reconnect.',
};
export function aiMessage(code: string) { return AI_MESSAGES[code] ?? 'Could not complete this AI request. Please try again.'; }
export const providerName = (name: string | null) => ({ groq: t('healthGroq'), sambanova: t('healthSambaNova'), local_llm: t('healthLocalModel'), none: t('providerNone') })[name ?? 'none'] ?? t('providerNone');
export const providerStatus = (status: string) => ({ not_configured: t('providerNotConfigured'), configured_unchecked: t('providerNotChecked'), ready: t('providerReady'), degraded: t('providerDegraded'), circuit_open: t('providerPaused'), auth_failed: t('providerRejected') })[status] ?? t('unknown');
export function unavailableReason(url: string, status?: AIStatus, privacy?: string): string | null {
  if (!url) return 'Connect a laptop in Settings.';
  if (!status) return 'Provider status unavailable. Refresh to try again.';
  if (privacy === 'local_only' && !status.local_available) return AI_MESSAGES.cloud_ai_disabled_for_event;
  if (!status.cloud_available && !status.local_available) return UNAVAILABLE;
  if (!privacy) return AI_MESSAGES.privacy_mode_unknown;
  return null;
}
