import { TranslationAPI } from './api';
import type { TranslateRequest, TranslationJob } from './types';
import { ServerError } from '../server/client';
import type { TranslationRepo, SessionRepo } from '../db/repositories';
import { terminal } from '../ai/types';

interface Clock { now(): number; setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(timer: ReturnType<typeof setTimeout>): void }
interface Dependencies {
  api: TranslationAPI; repo: TranslationRepo & Pick<SessionRepo, 'session'>; owner: string;
  clock?: Clock; changed?: (job: TranslationJob) => void;
}
/** Durable laptop jobs: retry polling, never retry a paid submission automatically. */
export class TranslationJobRunner {
  private clock: Clock;
  private stopped = true;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private busy?: Promise<void>;
  private next = new Map<string, { at: number; delay: number }>();
  constructor(private d: Dependencies) { this.clock = d.clock ?? { now: Date.now, setTimeout, clearTimeout }; }
  start() { this.stopped = false; this.schedule(0); }
  async stop() { this.stopped = true; this.generation++; if (this.timer) this.clock.clearTimeout(this.timer); await this.busy; }
  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.busy = this.tick().catch(() => {}).finally(() => { this.busy = undefined; this.schedule(2000); });
    }, ms);
  }
  async submit(request: TranslateRequest): Promise<TranslationJob> {
    const gen = this.generation;
    for (const id of request.session_ids) {
      const session = await this.d.repo.session(id);
      if (!session || session.owner_uid !== this.d.owner || session.event_id !== request.event_id || session.status !== 'finalized') throw new ServerError(0, 'transcript_incomplete', 'Choose finalized sessions');
    }
    if (gen !== this.generation) throw new ServerError(0, 'renew_required', 'Reconnect to request AI');
    const response = await this.d.api.submit(request);
    const ts = new Date(this.clock.now()).toISOString();
    const job: TranslationJob = { job_id: response.job_id, owner_uid: this.d.owner, event_id: request.event_id, kind: 'translate', target_lang: request.target_lang,
      session_ids: request.session_ids, status: 'queued', error_code: null, created_at: ts, updated_at: ts };
    // Persist even if sign-out happened while the laptop accepted the submission.
    await this.d.repo.putTranslationJob(job);
    this.next.set(job.job_id, { at: this.clock.now() + 2000, delay: 2000 });
    if (gen === this.generation) this.d.changed?.(job);
    return job;
  }
  /** A single serialized poll pass, also used by offline tests. */
  async tick(): Promise<void> {
    const gen = this.generation;
    for (const job of await this.d.repo.translationJobs(this.d.owner)) {
      if (gen !== this.generation) return;
      if (terminal(job.status)) continue;
      const retry = this.next.get(job.job_id) ?? { at: 0, delay: 2000 };
      if (retry.at > this.clock.now()) continue;
      try {
        const remote = await this.d.api.job(job.job_id);
        if (gen !== this.generation) return;
        const updated = { ...job, status: remote.status, error_code: remote.status === 'interrupted' ? 'interrupted' : remote.error_code, updated_at: new Date(this.clock.now()).toISOString() };
        if (remote.status === 'done') {
          for (const id of job.session_ids) {
            const rows = await this.d.api.translations(id, job.target_lang);
            if (gen !== this.generation) return;
            await this.d.repo.storeTranslations(id, job.target_lang, rows);
          }
          if ((remote.result?.failed ?? 0) > 0) updated.error_code = 'translation_unavailable';
        }
        await this.d.repo.putTranslationJob(updated);
        this.d.changed?.(updated);
        if (terminal(updated.status)) { this.next.delete(job.job_id); continue; }
      } catch (e) {
        if (gen !== this.generation) return;
        if (e instanceof ServerError && e.status === 404) {
          const failed: TranslationJob = { ...job, status: 'failed', error_code: 'not_found', updated_at: new Date(this.clock.now()).toISOString() };
          await this.d.repo.putTranslationJob(failed); this.d.changed?.(failed); this.next.delete(job.job_id); continue;
        }
        // Network, malformed responses and temporary server failures leave the job durable.
      }
      const delay = Math.min(10000, retry.delay * 2);
      this.next.set(job.job_id, { at: this.clock.now() + delay, delay });
    }
  }
}
