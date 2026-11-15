import { repositories, type NoteRepo } from '@/lib/db/repositories';
import { useAuthStore } from '@/state/authStore';
import { newNoteId, normalizeSearch, remoteFields, validateNoteInput, type Note, type NoteInput, type RemoteNote } from './model';
import { noteSync } from './noteSync';

/** Injected API also exercises the exact production mutation path in offline tests. */
export function notesApi(repo: NoteRepo, owner: string, notify = () => noteSync.notify(), now = () => new Date().toISOString()) {
  if (!owner) throw new Error('Sign in to take notes');
  async function mutate(id: string, patch: (n: Note) => Partial<Note>) {
    let found = false;
    await repo.updateNote(id, n => {
      if (n.owner_uid !== owner) throw new Error('Note unavailable');
      found = true;
      return patch(n);
    });
    if (!found) throw new Error('Note unavailable');
    notify();
  }
  const pending = (n: Note): Partial<Note> => ({ revision: Math.max(n.revision, n.synced_revision) + 1,
    sync_state: n.sync_state === 'conflict' ? 'conflict' : 'pending', last_error: null,
    attempts: 0, next_attempt_at: 0, updated_at: now() });
  return {
    async createNote(eventId: string, input: NoteInput) {
      const validated = validateNoteInput(input), ts = now();
      const value = { ...validated, text: input.source === 'transcript' ? input.text : validated.text };
      if (value.text.length > 5000) throw new Error('Enter a note of 1–5000 characters');
      if (value.source === 'ai') throw new Error('AI-assisted notes are not configured');
      const note: Note = { id: newNoteId(), event_id: eventId, owner_uid: owner, session_id: value.sessionId ?? null,
        sequence: value.sequence ?? null, source: value.source ?? 'manual', text: value.text,
        search_text: normalizeSearch(`${value.text} ${value.speaker ?? ''}`), timestamp_ms: value.timestampMs ?? null,
        speaker: value.speaker ?? null, language: value.language ?? null, deleted: 0, revision: 1,
        synced_revision: 0, remote_device: null, sync_state: 'pending', remote_json: null,
        last_error: null, attempts: 0, next_attempt_at: 0, created_at: ts, updated_at: ts };
      await repo.putNote(note); notify(); return note;
    },
    async editNote(id: string, input: Pick<NoteInput, 'text' | 'speaker'>) {
      const value = validateNoteInput(input);
      await mutate(id, n => {
        if (n.deleted) throw new Error('This note was deleted');
        return { ...pending(n), text: value.text, speaker: value.speaker ?? null, search_text: normalizeSearch(`${value.text} ${value.speaker ?? ''}`) };
      });
    },
    deleteNote: (id: string) => mutate(id, n => ({ ...pending(n), deleted: 1, text: '', speaker: null, search_text: normalizeSearch(' ') })),
    keepMine: (id: string) => mutate(id, n => {
      if (n.sync_state !== 'conflict' || !n.remote_json) return {};
      const remote: RemoteNote = JSON.parse(n.remote_json);
      return { ...pending(n), revision: Math.max(n.revision, n.synced_revision, remote.revision) + 1,
        synced_revision: remote.revision, remote_device: remote.deviceId, remote_json: null, sync_state: 'pending' };
    }),
    useCloud: (id: string) => mutate(id, n => n.sync_state === 'conflict' && n.remote_json ? remoteFields(JSON.parse(n.remote_json)) : {}),
    retryFailed: (id: string) => mutate(id, n => n.sync_state === 'failed' ? pending(n) : {}),
    listNotes: (eventId: string, search?: string) => repo.notes(owner, eventId, search),
    searchAll: async (q: string) => q.trim().length < 2 ? { notes: [], transcripts: [] } : {
      notes: await repo.searchNotes(owner, q.trim(), 50), transcripts: await repo.searchTranscripts(owner, q.trim(), 50)
    }
  };
}
async function api() { return notesApi(await repositories(), useAuthStore.getState().user?.uid ?? ''); }
export async function createNote(eventId: string, input: NoteInput) { return (await api()).createNote(eventId, input); }
export async function editNote(id: string, input: Pick<NoteInput, 'text' | 'speaker'>) { return (await api()).editNote(id, input); }
export async function deleteNote(id: string) { return (await api()).deleteNote(id); }
export async function keepMine(id: string) { return (await api()).keepMine(id); }
export async function useCloud(id: string) { return (await api()).useCloud(id); }
export async function retryFailed(id: string) { return (await api()).retryFailed(id); }
export async function listNotes(owner: string, eventId: string, search?: string) {
  if (!owner || useAuthStore.getState().user?.uid !== owner) return [];
  return (await repositories()).notes(owner,eventId,search);
}
export async function noteStates(owner: string, eventId: string) {
  if (!owner || useAuthStore.getState().user?.uid !== owner) return [];
  return (await repositories()).noteStates(owner,eventId);
}
export async function searchAll(owner: string, query: string) {
  if (!owner || useAuthStore.getState().user?.uid !== owner) return { notes: [], transcripts: [] };
  return notesApi(await repositories(), owner).searchAll(query);
}
