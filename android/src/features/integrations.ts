import type { Health } from '@/lib/server/types';
const definitions = [
  ['calendar','Calendar','Create and list calendar events after account consent.'],
  ['drive','Drive','Upload an export after choosing an account and folder.'],
  ['gmail','Gmail','Send a reviewed brief after explicit approval.'],
  ['app_check','App Check','Optional app verification; unconfigured verification never blocks the app.'],
  ['fcm','FCM','Optional push notifications after device consent.'],
  ['web_search','Web search','Enrich notes with external sources after privacy review.'],
  ['cloud_whisper','Cloud Whisper','Not configured; emergency English-only audio translation via Groq is available separately when enabled.'],
] as const;
export function integrationStatuses(health?: Health | null) {
  return definitions.map(([key,name,explanation]) => ({ name, explanation, enabled: false as const,
    status: health?.integrations?.[key]?.status === 'disabled' ? 'Disabled' : 'Not configured' }));
}
export const integrations = integrationStatuses();
