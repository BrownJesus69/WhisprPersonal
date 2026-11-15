import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authedClient } from '@/lib/server/authedClient';
import { AIAPI } from '@/lib/ai/api';
import { onAIChanged } from '@/lib/ai/runtime';
import { repositories } from '@/lib/db/repositories';
import { useSettingsStore } from '@/state/settingsStore';

export function useAI(owner: string | undefined, eventId: string | undefined) {
  const url = useSettingsStore(s => s.serverUrl);
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['ai-status', owner, url], enabled: !!owner && !!url,
    refetchInterval: 30000, queryFn: async () => {
      const server = authedClient(owner!); if (!server) throw new Error('No laptop');
      return new AIAPI(server).status();
    } });
  const local = useQuery({ queryKey: ['ai-local', owner, eventId], enabled: !!owner && !!eventId, refetchInterval: 2000,
    queryFn: async () => {
      const repo = await repositories();
      return { jobs: await repo.aiJobs(owner!, eventId!), drafts: await repo.briefDrafts(owner!, eventId!) };
    } });
  useEffect(() => onAIChanged(() => {
    void client.invalidateQueries({ queryKey: ['ai-local', owner, eventId] });
    void client.invalidateQueries({ queryKey: ['local-session', owner] });
  }), [client, owner, eventId]);
  return { url, status, local };
}
