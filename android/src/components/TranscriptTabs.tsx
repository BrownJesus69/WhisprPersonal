import { Text, View } from 'react-native';
import { Button } from './Button';
import { spacing, typography, useTheme } from '@/theme';

export function TranscriptTabs() {
  const t = useTheme();
  return <View style={{ gap: spacing.xs }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: spacing.xs }}>
      <Button label="Raw" selected onPress={() => {}} />
      <Button label="Polished" disabled secondary onPress={() => {}} />
    </View>
    <Text style={{ ...typography.label, color: t.muted }}>Cleanup arrives with Cloud AI later. Your raw transcript is always kept unchanged.</Text>
  </View>;
}
