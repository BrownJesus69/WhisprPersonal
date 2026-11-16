import { fontFor, lineHeightFor } from '@/theme/fonts';
import { FlatList, Text, View } from 'react-native';
import type { LocalSession, TranscriptRow } from '@/lib/db/repositories';
import type { Target, Translation } from '@/lib/translation/types';
import { translationParts, translationLabel, polishLabel, audioLabel } from '@/lib/translation/labels';
import { spacing, typography, useTheme } from '@/theme';
import { Banner } from './Banner';
export function TranslationList({ session, originals, rows, target, search = '' }: {
  session: LocalSession; originals: TranscriptRow[]; rows: Translation[]; target: Target; search?: string;
}) {
  const t = useTheme();
  const parts = translationParts(session,originals,rows,target).filter(r => `${r.text} ${r.translated?.polished_text ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <FlatList accessibilityLabel="Translation rows" data={parts} keyExtractor={r => String(r.sequence)}
    ListEmptyComponent={<Banner message="No matching translation rows." />}
    renderItem={({ item }) => <View style={{ paddingVertical: spacing.sm, gap: spacing.xs, borderBottomWidth: 1, borderBottomColor: t.border }}>
      {item.translated ? <>
        <Text style={{ ...typography.label, color: t.muted }}>{translationLabel(item.translated)}</Text>
        {item.translated.source_lang === 'und' && item.translated.engine === 'groq-audio-translation' && <Text style={{ ...typography.label, color: t.muted }}>{audioLabel}</Text>}
      </> : <Text style={{ ...typography.label, color: t.muted }}>Not translated</Text>}
      <Text selectable style={{ ...typography.body, color: t.text, fontFamily: fontFor(item.text), lineHeight: lineHeightFor(item.text, 16) }}>{item.text}</Text>
      {item.translated?.polished_text != null && <View style={{ padding: spacing.sm, backgroundColor: t.surface, gap: spacing.xs }}>
        <Text style={{ ...typography.label, color: t.muted }}>{polishLabel(item.translated)}</Text>
        <Text selectable style={{ ...typography.body, color: t.text, fontFamily: fontFor(item.translated.polished_text), lineHeight: lineHeightFor(item.translated.polished_text, 16) }}>{item.translated.polished_text}</Text>
      </View>}
    </View>} />;
}
