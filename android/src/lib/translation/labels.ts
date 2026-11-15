import { providerName } from '../ai/messages';
import type { LocalSession, TranscriptRow } from '../db/repositories';
import { transcriptParts } from '../export/compose';
import type { Target, Translation } from './types';
export const engineName = (engine: Translation['engine']) => engine === null ? 'Not translated' : ({ indictrans2: 'IndicTrans2', libretranslate: 'LibreTranslate', 'groq-audio-translation': 'Groq audio translation' })[engine];
export const translationLabel = (r: Translation) => `${engineName(r.engine)} · ${r.model} · ${r.source_lang}→${r.target_lang} · ${new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
export const polishLabel = (r: Translation) => `AI-polished (${providerName(r.polish_provider)} · ${r.polish_model ?? 'Not supplied'})`;
export const audioLabel = 'Emergency English translation from audio (Groq) — no transcript was produced';
export function translationParts(session: LocalSession, originals: TranscriptRow[], rows: Translation[], target: Target) {
  const translations = rows.filter(r => r.session_id === session.id && r.target_lang === target);
  const raw = transcriptParts(session, originals, 'raw');
  // Emergency audio translations can exist even without a transcript row.
  const sequences = [...new Set([...raw.map(r => r.sequence), ...translations.map(r => r.sequence)])].sort((a,b) => a-b);
  return sequences.map(sequence => {
    const original = raw.find(r => r.sequence === sequence);
    const r = translations.find(r => r.sequence === sequence);
    const translated = r && !r.error_code && !!r.text?.trim() ? r : undefined;
    return { sequence, original, translated, text: translated?.text ?? original?.text ?? '[part not transcribed]' };
  });
}
