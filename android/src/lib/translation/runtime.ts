import { AppState } from 'react-native';
import { repositories } from '../db/repositories';
import { authedClient } from '../server/authedClient';
import { TranslationAPI } from './api';
import { TranslationJobRunner } from './jobs';


const listeners = new Set<() => void>();
export const onTranslationChanged = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
let runner: TranslationJobRunner | undefined;
let generation = 0;
let remove: (() => void) | undefined;
let ownerUid: string | undefined;
export const translationRuntime = {
  async start(owner: string) {
    const gen = ++generation;
    const old = runner; runner = undefined; ownerUid = undefined; remove?.(); remove = undefined;
    await old?.stop();
    const repo = await repositories();
    if (gen !== generation) return;
    const client = authedClient(owner); if (!client) return;
    const changed = () => { if (gen === generation) listeners.forEach(l => l()); };
    runner = new TranslationJobRunner({ owner, repo, api: new TranslationAPI(client), changed }); ownerUid = owner;
    const app = AppState.addEventListener('change', state => { if (state === 'active') listeners.forEach(l => l()); });
    remove = () => app.remove(); runner.start();
  },
  stop() { generation++; const old = runner; runner = undefined; ownerUid = undefined; remove?.(); remove = undefined; return old?.stop(); },
  get(owner: string) { return ownerUid === owner ? runner : undefined; },
};
