import { t } from '@/i18n';
const messages: Record<string, string> = {
  missing_server_key: t('server_missing_server_key'),
  invalid_server_key: t('server_invalid_server_key'),
  server_not_configured: t('server_server_not_configured'),
  missing_auth_token: t('server_missing_auth_token'),
  invalid_auth_token: t('server_invalid_auth_token'),
  auth_token_expired: t('server_auth_token_expired'),
  auth_unavailable: t('server_auth_unavailable'),
  auth_not_configured: t('server_auth_not_configured'),
  account_not_allowed: t('server_account_not_allowed'),
  network_not_allowed: t('server_network_not_allowed'),
  firestore_unavailable: t('server_firestore_unavailable'),
};

export function serverMessage(code: string, status: number, retryAfterS?: number) {
  return messages[code] ?? (code === 'rate_limited' ? t('serverRateLimited', { seconds: retryAfterS ?? t('aFew') }) : t('serverRequestFailed', { status }));
}
