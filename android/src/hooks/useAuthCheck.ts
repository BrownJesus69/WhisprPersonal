import { useMutation } from '@tanstack/react-query';
import { createTokenManager } from '@/lib/server/tokenManager';
import type { AuthCheck } from '@/lib/server/types';

export function useAuthCheck() {
  return useMutation({ retry: false, mutationFn: (url: string) => createTokenManager(url).client.get<AuthCheck>('/api/v1/auth/check') });
}
