import { create } from 'zustand';
import { apply, initialTranscript, withFinal } from './transcriptModel';
import type { TranscriptState } from './transcriptModel';
import type { LanguageMode, PartialEvent, PersistedEvent } from './events';
import type { Repositories } from '../db/repositories';
import type { LiveStatus } from './streamClient';

export interface SessionView { model: TranscriptState; status: LiveStatus; attempt: number; hydrated: boolean }
export const emptyView: SessionView = { model: initialTranscript(), status: 'offline', attempt: 0, hydrated: false };
interface Store {
  sessions: Record<string, SessionView>;
  setStatus: (id: string, status: LiveStatus, attempt: number) => void;
  dispatch: (event: PersistedEvent | PartialEvent) => void;
  dispatchPartials: (events: PartialEvent[]) => void;
  override: (id: string, mode: LanguageMode) => void;
  hydrate: (repo: Repositories, id: string) => Promise<void>;
  reset: (id: string) => void;
}
export const useTranscriptStore = create<Store>()((set) => ({
  sessions: {},
  setStatus: (id, status, attempt) => set(s => ({ sessions: { ...s.sessions, [id]: { ...(s.sessions[id] ?? emptyView), status, attempt } } })),
  dispatch: event => set(s => {
    const id = event.session_id, view = s.sessions[id] ?? emptyView;
    const model = apply(view.model, event);
    if (model === view.model) return s;
    // Historical replay must not overwrite a newer local/offline picker selection.
    model.language = { ...model.language, mode: view.model.language.mode };
    return { sessions: { ...s.sessions, [id]: { ...view, model } } };
  }),
  dispatchPartials: events => set(s => {
    if (!events.length) return s;
    const id = events[0].session_id, view = s.sessions[id] ?? emptyView;
    const model = events.reduce((model, event) => apply(model, event), view.model);
    return { sessions: { ...s.sessions, [id]: { ...view, model } } };
  }),
  override: (id, mode) => set(s => {
    const view = s.sessions[id] ?? emptyView;
    return { sessions: { ...s.sessions, [id]: { ...view, model: { ...view.model, language: { ...view.model.language, mode } } } } };
  }),
  reset: id => set(s => ({ sessions: { ...s.sessions, [id]: { ...(s.sessions[id] ?? emptyView), model: { ...initialTranscript(), finals: s.sessions[id]?.model.finals ?? new Map(), language: { ...initialTranscript().language, mode: s.sessions[id]?.model.language.mode ?? 'auto' } } } } })),
  async hydrate(repo, id) {
    const before = useTranscriptStore.getState().sessions[id]?.model;
    // Controller serializes hydration with stream callbacks; poll refresh merges durable rows.
    const [session, events, rows] = await Promise.all([repo.session(id), repo.streamEvents(id), repo.transcript(id)]);
    if (!session) return;
    let model = initialTranscript();
    for (const event of events) model = apply(model, event);
    for (const row of rows) model = withFinal(model, row, row.revision);
    model.lastSeq = session.last_event_seq ?? 0;
    model.language.mode = session.language_override ?? 'auto';
    set(s => {
      const view = s.sessions[id] ?? emptyView;
      if (s.sessions[id]?.model !== before) return s;
      if (view.model.lastSeq > model.lastSeq) return s;
      model.partials = view.model.partials;
      for (const sequence of model.finals.keys()) model.partials = new Map([...model.partials].filter(([n]) => n !== sequence));
      return { sessions: { ...s.sessions, [id]: { ...view, model, hydrated: true } } };
    });
  }
}));
