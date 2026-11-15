import type { LanguageMode } from './events';
import { isMode } from './events';
import type { LocalSession, Repositories } from '../db/repositories';

export function chunkLanguage(session: Pick<LocalSession, 'language_override' | 'override_from_sequence'>, sequence: number): Exclude<LanguageMode, 'auto'> | undefined {
  const mode = session.language_override;
  return mode && mode !== 'auto' && session.override_from_sequence != null && sequence >= session.override_from_sequence ? mode : undefined;
}
interface Dependencies {
  repo: Repositories;
  nextSequence: (id: string) => Promise<number> | number;
  send: (id: string, mode: LanguageMode) => boolean;
  post: (id: string, mode: LanguageMode) => Promise<unknown>;
  changed: (id: string, mode: LanguageMode) => void;
}
/** Local intention is durable before best-effort transport. Serialize rapid chip taps. */
export class LanguageOverride {
  private d: Dependencies;
  private lane: Promise<void> = Promise.resolve();
  constructor(deps: Dependencies) { this.d = deps; }
  setOverride(id: string, mode: LanguageMode): Promise<void> {
    const task = this.lane.then(async () => {
      if (!isMode(mode)) throw new Error('Invalid language');
      const sequence = await this.d.nextSequence(id);
      await this.d.repo.setLanguageOverride(id, mode, sequence);
      this.d.changed(id, mode);
      await this.propagate(id, mode);
    });
    this.lane = task.catch(() => {});
    return task;
  }
  private async propagate(id: string, mode: LanguageMode) {
    if (this.d.send(id, mode)) return;
    try { await this.d.post(id, mode); }
    catch { /* Includes finalized/409: keep local intention and retry on reconnect. */ }
  }
  async onReconnect(id: string) {
    await this.lane;
    const session = await this.d.repo.session(id);
    // Re-send durable intention, including Auto, after process death or offline use.
    if (session?.override_from_sequence != null) await this.propagate(id, session.language_override ?? 'auto');
  }
}
