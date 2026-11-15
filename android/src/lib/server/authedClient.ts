import { ServerClient, ServerError } from './client';
import { credentials } from './credentials';
import { createTokenManager } from './tokenManager';
import { auth } from '@/lib/firebase/auth';
import { useAuthStore } from '@/state/authStore';
import { useSettingsStore } from '@/state/settingsStore';

export function authedClient(owner: string): ServerClient | null {
  const url = useSettingsStore.getState().serverUrl;
  if (!url) return null;
  const tokens = createTokenManager(url);
  const sameAccount = () => auth.current()?.uid === owner && useAuthStore.getState().user?.uid === owner;
  return new ServerClient({ baseUrl: url, getServerKey: credentials.getServerKey,
    getBearer: async () => {
      if (!sameAccount()) throw new ServerError(0, 'renew_required', 'Sign in to the recording account');
      const bearer = await tokens.getBearer();
      if (!sameAccount()) throw new ServerError(0, 'renew_required', 'Sign in to the recording account');
      return bearer;
    }, onAuthExpired: tokens.onAuthExpired });
}
