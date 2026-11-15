import { Text, View } from 'react-native';
import { Button } from './Button';
import { spacing, typography, useTheme } from '@/theme';

export function TranscriptTabs({ selected = 'raw', onSelect = () => {} }: { selected?: 'raw' | 'polished'; onSelect?: (tab: 'raw' | 'polished') => void }) {
  const t = useTheme();
  return <View style={{ gap: spacing.xs }}>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: spacing.xs }}>
      <Button role="tab" label="Raw" selected={selected === 'raw'} secondary={selected !== 'raw'} onPress={() => onSelect('raw')} />
      <Button role="tab" label="Polished" selected={selected === 'polished'} secondary={selected !== 'polished'} onPress={() => onSelect('polished')} />
    </View>
    <Text style={{ ...typography.label, color: t.muted }}>{selected === 'polished' ? 'AI-cleaned text. Your raw transcript is unchanged.' : 'Raw transcript. Your original words are preserved.'}</Text>
  </View>;
}
