import { Text } from 'react-native';
import { typography, useTheme } from '@/theme';
import type { TranscriptState } from '@/lib/live/transcriptModel';

export const languageName = (code?: string) => ({ kn: 'Kannada', ta: 'Tamil', hi: 'Hindi', en: 'English', auto: 'Auto' })[code ?? ''] ?? code ?? 'Detecting language';
export function LanguageBadge({ language }: { language: TranscriptState['language'] }) {
  const t = useTheme();
  const text = language.mode !== 'auto' ? `Forced: ${languageName(language.mode)}` :
    `${languageName(language.current ?? language.locked)}${language.confidence == null ? '' : ` · ${Math.round(language.confidence * 100)}%`}${language.uncertain ? ' · ? uncertain' : ''}`;
  return <Text accessibilityLabel={text} style={{ ...typography.label, color: language.uncertain ? t.warning : t.primary }}>{text}</Text>;
}
