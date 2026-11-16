import { t } from '@/i18n';
import type { Health } from '@/lib/server/types';
const definitions = [
  ['calendar',t('integrationCalendar'),t('integrationCalendarHelp')],
  ['drive',t('integrationDrive'),t('integrationDriveHelp')],
  ['gmail',t('integrationGmail'),t('integrationGmailHelp')],
  ['app_check',t('integrationAppCheck'),t('integrationAppCheckHelp')],
  ['fcm',t('integrationFcm'),t('integrationFcmHelp')],
  ['web_search',t('integrationWebSearch'),t('integrationWebSearchHelp')],
  ['cloud_whisper',t('integrationCloudWhisper'),t('integrationCloudWhisperHelp')],
] as const;
export function integrationStatuses(health?: Health | null) {
  return definitions.map(([key,name,explanation]) => ({ name, explanation, enabled: false as const,
    status: health?.integrations?.[key]?.status === 'disabled' ? t('disabled') : t('providerNotConfigured') }));
}
export const integrations = integrationStatuses();
