import { View, Text } from 'react-native';
import { useTheme, spacing, typography } from '@/theme';

export function LevelMeter({ dbfs }: { dbfs: number }) {
  const t = useTheme();
  const clipped = dbfs >= -1;
  const level = Math.max(0, Math.min(100, (dbfs + 60) / 60 * 100));
  return <View style={{ gap: spacing.xs }} accessibilityLabel={`Microphone ${Math.round(dbfs)} dBFS${clipped ? ', clipping' : ''}`}>
    <View style={{ height: spacing.md, backgroundColor: t.border, borderRadius: spacing.xs, overflow: 'hidden' }}>
      <View style={{ height: '100%', width: `${level}%`, backgroundColor: clipped ? t.danger : t.primary }} />
    </View>
    <Text style={{ ...typography.label, color: clipped ? t.danger : t.muted }}>{clipped ? 'Clipping — move the phone away from the speaker' : `${Math.round(dbfs)} dBFS`}</Text>
  </View>;
}
