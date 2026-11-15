import { Text, View, Switch, Pressable } from 'react-native';
import { ChipSelect } from './ChipSelect';
import type { BriefType } from '@/lib/ai/types';
import { spacing, typography, useTheme } from '@/theme';

export const briefOptions: { value: BriefType; label: string }[] = [
  { value: 'summary', label: 'Summary' }, { value: 'action_items', label: 'Action items' },
  { value: 'decisions', label: 'Decisions' }, { value: 'follow_ups', label: 'Follow-ups' }, { value: 'full', label: 'Full brief' },
];
export function BriefTypeChips({ value, change }: { value: BriefType; change: (value: BriefType) => void }) {
  return <ChipSelect options={briefOptions} selected={[value]} onSelect={change} />;
}
export function Toggle({ label, value, change, checkbox = false }: { label: string; value: boolean; change: (value: boolean) => void; checkbox?: boolean }) {
  const t = useTheme();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48 }}>
    {checkbox ? <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => change(!value)} style={{ minHeight: 48, flex: 1, justifyContent: 'center' }}>
      <Text style={{ ...typography.body, color: t.text }}>{value ? '☑' : '☐'} {label}</Text>
    </Pressable> : <>
      <Text style={{ ...typography.body, color: t.text, flex: 1 }}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={change} />
    </>}
  </View>;
}
