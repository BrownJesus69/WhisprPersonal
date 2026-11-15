import { getFirestore, collection, doc, setDoc, query, orderBy, limit, onSnapshot, serverTimestamp, Timestamp } from '@react-native-firebase/firestore';
import { repositories, type AIRepo } from '../db/repositories';
import { BRIEF_TYPES, type BriefDraft, type BriefType, type Provider, type StructuredBrief } from './types';
import { structured } from './api';

export const BRIEF_KEYS = ['ownerId','type','status','provider','model','generatedText','finalText','edited','structuredBrief','incomplete','sessionIds','createdAt','updatedAt'] as const;
export interface SavedBrief {
  id: string; ownerId: string; type: BriefType; status: 'saved'; provider: Provider; model: string | null;
  generatedText: string; finalText: string; edited: boolean; structuredBrief: StructuredBrief | null;
  incomplete: boolean; sessionIds: string[]; createdAt: Timestamp; updatedAt: Timestamp | null;
}
export function briefDocument(owner: string, draft: BriefDraft) {
  if (!owner || draft.owner_uid !== owner) throw new Error('Brief is not available');
  if (!draft.edited_text.trim() || draft.edited_text.length > 100000 || draft.generated_text.length > 100000) throw new Error('Enter 1–100000 characters');
  const structuredBrief: unknown = draft.structured_json === null ? null : JSON.parse(draft.structured_json);
  if (!structured(structuredBrief)) throw new Error('Invalid structured brief');
  return { ownerId: owner, type: draft.brief_type, status: 'saved' as const, provider: draft.provider ?? 'none',
    model: draft.model, generatedText: draft.generated_text, finalText: draft.edited_text,
    edited: draft.edited_text !== draft.generated_text, structuredBrief: structuredBrief as StructuredBrief | null,
    incomplete: !!draft.incomplete, sessionIds: draft.session_ids, createdAt: Timestamp.fromDate(new Date(draft.created_at)), updatedAt: serverTimestamp() };
}
/** Do not await Firestore acknowledgement: it may remain pending all day offline. */
function background(write: Promise<unknown>, rejected?: () => void) { void write.catch(() => rejected?.()); }
export async function saveBrief(owner: string, draft: BriefDraft, onSyncError?: () => void, repo?: AIRepo) {
  const data = briefDocument(owner, draft);
  const local = repo ?? await repositories();
  background(setDoc(doc(getFirestore(), 'events', draft.event_id, 'briefs', draft.id), data), onSyncError);
  await local.putBriefDraft({ ...draft, status: 'saved', updated_at: new Date().toISOString() });
  return draft.id;
}
export function fromBrief(id: string, data: Record<string, unknown>): SavedBrief | null {
  if (Object.keys(data).length !== BRIEF_KEYS.length || !BRIEF_KEYS.every(k => k in data)
    || typeof data.ownerId !== 'string' || !BRIEF_TYPES.includes(data.type as BriefType) || data.status !== 'saved'
    || !['groq','sambanova','local_llm','none'].includes(data.provider as string)
    || !(data.model === null || (typeof data.model === 'string' && data.model.length <= 200))
    || typeof data.generatedText !== 'string' || data.generatedText.length > 100000
    || typeof data.finalText !== 'string' || !data.finalText.length || data.finalText.length > 100000
    || typeof data.edited !== 'boolean' || typeof data.incomplete !== 'boolean' || !structured(data.structuredBrief)
    || !Array.isArray(data.sessionIds) || data.sessionIds.length > 20 || !data.sessionIds.every(s => typeof s === 'string')
    || !(data.createdAt instanceof Timestamp) || !(data.updatedAt === null || data.updatedAt instanceof Timestamp)) return null;
  return { id, ...data } as unknown as SavedBrief;
}
export function subscribeBriefs(eventId: string, next: (briefs: SavedBrief[], cached: boolean) => void, error: () => void) {
  return onSnapshot(query(collection(getFirestore(), 'events', eventId, 'briefs'), orderBy('createdAt', 'desc'), limit(50)),
    { includeMetadataChanges: true }, snapshot => next(snapshot.docs.flatMap(d => {
      const value = fromBrief(d.id, d.data()); return value ? [value] : [];
    }), snapshot.metadata.fromCache), error);
}
