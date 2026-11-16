import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function SettingsRow({ title, description, onPress, children }: { title: string; description?: string; onPress?: () => void; children?: ReactNode }) {
  const c = useTheme();
  const content = <><View style={{ flex: 1, gap: spacing.xs }}><Text style={{ ...typography.body, color: c.text }}>{title}</Text>{!!description && <Text style={{ ...typography.caption, color: c.muted }}>{description}</Text>}</View>{children}{onPress && <Text style={{ ...typography.body, color: c.muted }}>›</Text>}</>;
  const style = { minHeight: 64, paddingVertical: spacing.sm, gap: spacing.sm, borderBottomWidth: 1, borderColor: c.border, flexDirection: 'row' as const, alignItems: 'center' as const };
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [style, { opacity: pressed ? 0.65 : 1 }]}>{content}</Pressable> : <View style={style}>{content}</View>;
}
