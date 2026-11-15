const messages: Record<string, string> = {
  missing_server_key: 'Enter the laptop server key',
  invalid_server_key: 'The server key is incorrect. Check it on your laptop.',
  server_not_configured: 'Configure the shared server key on your laptop before connecting.',
  missing_auth_token: 'Sign in to continue',
  invalid_auth_token: 'Sign in again to connect to the laptop.',
  auth_token_expired: 'Reconnect to the internet to renew sign-in',
  auth_unavailable: 'Laptop sign-in verification is temporarily unavailable. Try again.',
  auth_not_configured: 'Configure Firebase token verification on your laptop.',
  account_not_allowed: 'This account is not allowed on the laptop',
  network_not_allowed: 'The laptop accepts LAN or Tailscale connections only. Check the server network filter.',
  firestore_unavailable: 'Firebase is temporarily unavailable on the laptop. Try again.',
};

export function serverMessage(code: string, status: number, retryAfterS?: number) {
  return messages[code] ?? (code === 'rate_limited' ? `Too many requests. Try again in ${retryAfterS ?? 'a few'} seconds` : `Laptop request failed (${status})`);
}
