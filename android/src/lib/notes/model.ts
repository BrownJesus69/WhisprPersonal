import { randomUUID } from 'expo-crypto';

export type NoteSource = 'manual' | 'transcript' | 'ai';
export type SyncState = 'pending' | 'synced' | 'conflict' | 'failed';
export interface NoteInput {
  text: string; speaker?: string | null; source?: NoteSource; timestampMs?: number | null;
  sessionId?: string | null; sequence?: number | null; language?: string | null;
}
export interface Note {
  id: string; event_id: string; owner_uid: string; session_id: string | null; sequence: number | null;
  source: NoteSource; text: string; search_text: string; timestamp_ms: number | null;
  speaker: string | null; language: string | null; deleted: number; revision: number;
  synced_revision: number; remote_device: string | null; sync_state: SyncState;
  remote_json: string | null; last_error: string | null; attempts: number; next_attempt_at: number;
  created_at: string; updated_at: string;
}
export interface RemoteNote {
  id: string; ownerId: string; source: NoteSource; text: string; timestampMs: number | null;
  speaker: string | null; sessionId: string | null; sequence: number | null; language: string | null;
  deleted: boolean; revision: number; baseRevision: number; deviceId: string;
  createdAt: string; updatedAt: string;
}
export const normalizeSearch = (s: string) => s.normalize('NFC').toLocaleLowerCase();
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
export const newNoteId = () => `note_${randomUUID().replace(/-/g, '')}`;
export function validateNoteInput(input: NoteInput): NoteInput {
  const text = input.text.trim();
  if (!text || text.length > 5000) throw new Error('Enter a note of 1–5000 characters');
  if (input.speaker != null && input.speaker.length > 100) throw new Error('Speaker must be 100 characters or fewer');
  if (input.source && !['manual', 'transcript', 'ai'].includes(input.source)) throw new Error('Invalid note source');
  for (const value of [input.timestampMs, input.sequence]) if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid recording time or sequence');
  if (input.sessionId != null && input.sessionId.length > 128) throw new Error('Invalid session');
  if (input.language != null && input.language.length > 8) throw new Error('Invalid language');
  return { ...input, text };
}
export type MergeAction = { type: 'ignore' } | { type: 'apply'; remote: RemoteNote } |
  { type: 'ack'; revision: number } | { type: 'conflict'; remote: RemoteNote } | { type: 'failed'; code: string };
export function mergeRemote(local: Note | null, remote: RemoteNote, myDevice: string): MergeAction {
  if (!local) return { type: 'apply', remote };
  if (remote.ownerId !== local.owner_uid || remote.revision <= local.synced_revision) return { type: 'ignore' };
  if (remote.deviceId === myDevice) return { type: 'ack', revision: remote.revision };
  // A conflict may have observed a newer cloud version than synced_revision. Do not
  // replace that evidence with a stale snapshot (especially a pre-deletion copy).
  if (local.sync_state === 'conflict' && local.remote_json && remote.revision <= (JSON.parse(local.remote_json) as RemoteNote).revision) return { type: 'ignore' };
  // Any unpublished local revision (pending, conflict, or a rejected/failed edit) must never be
  // overwritten by another device's version: surface it as a conflict instead.
  if (local.sync_state !== 'synced' || local.revision > local.synced_revision) return { type: 'conflict', remote };
  return { type: 'apply', remote };
}
export function onRejected(local: Note, server: RemoteNote | null, myDevice: string, pushedRevision = local.revision): MergeAction {
  if (!server || server.ownerId !== local.owner_uid) return { type: 'failed', code: 'rejected' };
  if (server.deviceId === myDevice && server.revision >= pushedRevision) return { type: 'ack', revision: server.revision };
  return { type: 'conflict', remote: server };
}
export function remoteFields(remote: RemoteNote): Partial<Note> {
  return { source: remote.source, text: remote.text, speaker: remote.speaker, deleted: Number(remote.deleted),
    timestamp_ms: remote.timestampMs, session_id: remote.sessionId, sequence: remote.sequence,
    language: remote.language, search_text: normalizeSearch(`${remote.text} ${remote.speaker ?? ''}`),
    revision: remote.revision, synced_revision: remote.revision, remote_device: remote.deviceId,
    sync_state: 'synced', remote_json: null, last_error: null, attempts: 0, next_attempt_at: 0,
    created_at: remote.createdAt, updated_at: remote.updatedAt };
}
