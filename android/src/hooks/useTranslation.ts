import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { repositories, type LocalSession } from '@/lib/db/repositories';
import { authedClient } from '@/lib/server/authedClient';
import { TranslationAPI } from '@/lib/translation/api';
import { onTranslationChanged } from '@/lib/translation/runtime';
import { terminal } from '@/lib/ai/types';
import { UNAVAILABLE, type Target } from '@/lib/translation/types';
import { useSettingsStore } from '@/state/settingsStore';
export function useTranslation(session?: LocalSession) {
  const [target, setTarget] = useState<Target>('en');
  const url = useSettingsStore(s => s.serverUrl);
  const client = useQueryClient();
  const owner = session?.owner_uid, id = session?.id;
  const local = useQuery({ queryKey: ['translations',owner,id,target], enabled: !!session, refetchInterval: 2000,
    queryFn: async () => {
      const repo = await repositories();
      return { rows: await repo.translations(id!,target), jobs: (await repo.translationJobs(owner!,session!.event_id)).filter(j => j.target_lang === target && j.session_ids.includes(id!)) };
    } });
  // Retrieve translations made on the laptop too, including audio fallback rows missed offline.
  const remote = useQuery({ queryKey: ['translation-fetch',owner,id,target,url], enabled: !!session && session.status === 'finalized' && !!url, retry: false,
    queryFn: async () => {
      const server = authedClient(owner!); if (!server) throw new Error('Offline');
      const rows = await new TranslationAPI(server).translations(id!,target);
      await (await repositories()).storeTranslations(id!,target,rows);
      await client.invalidateQueries({ queryKey: ['translations',owner,id,target] });
      return true;
    } });
  useEffect(() => onTranslationChanged(() => { void client.invalidateQueries({ queryKey: ['translations',owner,id] }); }), [client,owner,id]);
  const job = local.data?.jobs[0];
  return { target, setTarget, rows: local.data?.rows ?? [], job, active: !!job && !terminal(job.status),
    message: remote.error || local.error || (job && (job.error_code || ['failed','interrupted'].includes(job.status))) ? UNAVAILABLE : '' };
}
