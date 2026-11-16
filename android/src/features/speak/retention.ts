import { repositories, type LocalSession } from '@/lib/db/repositories';
import { deleteSession, LaptopUnavailable } from '@/lib/session/deleteSession';
import { File } from 'expo-file-system';
import { deleteAudio, listChunkFiles, removeParts, sessionDirectory } from '@/lib/audio/chunkFiles';
import { authedClient } from '@/lib/server/authedClient';
import { useRecordingStore } from '@/lib/session/recordingStore';
import { useSettingsStore } from '@/state/settingsStore';
import { kv } from '@/lib/storage/kv';
import { draftKey } from './drafts';
import { speakEventId } from './speakEvent';

function removeSessionAudioFiles(id: string): void {
  for (const file of listChunkFiles(id)) file.delete();
  removeParts(id);
  const directory = sessionDirectory(id);
  // Recovery may have kept several master files; master_uri points only to the latest one.
  if (directory.exists) for (const file of directory.list()) {
    if (file instanceof File && (file.name === 'master.wav' || /^master_\d+_[a-f0-9]{32}\.wav$/.test(file.name))) file.delete();
  }
}

export function retentionEligible(session: LocalSession, owner: string, eventId: string, reason: 'start' | 'startup', now = Date.now()): boolean {
  const finalizedAt = Date.parse(session.server_finalized_at || session.updated_at);
  return !!eventId && session.owner_uid === owner && session.event_id === eventId && session.status === 'finalized'
    && (reason === 'start' || Number.isFinite(finalizedAt) && now - finalizedAt > 24 * 60 * 60 * 1000);
}

export async function removeRecording(owner: string, id: string): Promise<{ pending: boolean }> {
  const repo = await repositories();
  const session = await repo.session(id);
  if (!session || session.owner_uid !== owner) throw new Error('session_unavailable');
  const active = useRecordingStore.getState();
  if (active.sessionId === id && ['recording', 'paused', 'error'].includes(active.phase)) await active.stop();
  const r = useRecordingStore.getState();
  const options = { repo, client: authedClient(owner), owner, id, activeId: r.sessionId, phase: r.phase, removeFile: deleteAudio,
    removeOrphans: removeSessionAudioFiles };
  let pending = false;
  try { await deleteSession(options); }
  catch (error) {
    if (!(error instanceof LaptopUnavailable)) throw error;
    await deleteSession({ ...options, phoneOnly: true });
    pending = true;
  }
  await kv.removeItem(draftKey(owner, id));
  await kv.removeItem(draftKey(owner, id, true));
  return { pending };
}

export async function applySpeakRetention(owner: string, reason: 'start' | 'startup'): Promise<{ failed: number; pending: number }> {
  const result = { failed: 0, pending: 0 };
  if (useSettingsStore.getState().keepTranscripts) return result;
  const id = speakEventId(owner);
  for (const session of await (await repositories()).sessions(owner)) {
    if (retentionEligible(session, owner, id, reason)) {
      try { if ((await removeRecording(owner, session.id)).pending) result.pending++; }
      catch { result.failed++; }
    }
  }
  return result;
}

export async function removePhoneAudio(owner: string, id: string): Promise<void> {
  const repo = await repositories(), session = await repo.session(id);
  if (!session || session.owner_uid !== owner || session.status !== 'finalized') throw new Error('not_finalized');
  for (const chunk of await repo.chunks(id)) {
    if (!chunk.local_deleted) deleteAudio(chunk.uri);
    await repo.updateChunk(chunk.chunk_id, { local_deleted: 1 });
  }
  if (session.master_uri) deleteAudio(session.master_uri);
  removeSessionAudioFiles(id);
  await repo.updateSession(id, { master_uri: '' });
}
