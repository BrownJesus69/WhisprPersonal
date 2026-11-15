import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import { repositories } from '../db/repositories';
import { authedClient } from '../server/authedClient';
import { AIAPI } from './api';
import { AIJobRunner } from './jobs';
import type { AIJob, CleanupResult } from './types';

const listeners = new Set<() => void>();
const results = new Map<string, CleanupResult>();
export const onAIChanged = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const cleanupResult = (id: string) => results.get(id);
let runner: AIJobRunner | undefined;
let generation = 0;
let remove: (() => void) | undefined;
let ownerUid: string | undefined;
export const aiRuntime = {
  async start(owner: string) {
    const gen = ++generation;
    const old = runner; runner = undefined; ownerUid = undefined; remove?.(); remove = undefined;
    await old?.stop();
    const repo = await repositories();
    if (gen !== generation) return;
    const client = authedClient(owner); if (!client) return;
    const changed = (job: AIJob, result?: CleanupResult) => {
      if (gen !== generation) return;
      if (result) results.set(job.job_id, result);
      listeners.forEach(l => l());
    };
    runner = new AIJobRunner({ newId: () => `brief_${randomUUID().replaceAll('-','')}`, owner, repo, api: new AIAPI(client), changed }); ownerUid = owner;
    const app = AppState.addEventListener('change', state => { if (state === 'active') listeners.forEach(l => l()); });
    remove = () => app.remove(); runner.start();
  },
  stop() { generation++; const old = runner; runner = undefined; ownerUid = undefined; results.clear(); remove?.(); remove = undefined; return old?.stop(); },
  get(owner: string) { return ownerUid === owner ? runner : undefined; },
};
