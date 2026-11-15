import { useMutation } from '@tanstack/react-query';
import { ServerClient } from '@/lib/server/client';
import type { Health } from '@/lib/server/types';

export function useHealth() {
  return useMutation({
    retry: false, mutationFn: (url: string) => new ServerClient({
      baseUrl: url,
      getServerKey: async () => null,
      getBearer: async () => '',
      onAuthExpired: async () => {
      }
    }).get<Health>('/health', { auth: false })
  });
}
