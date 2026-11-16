import type { PropsWithChildren } from 'react';
import { Text, View } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';
export function SettingsGroup({ title, children }: PropsWithChildren<{ title: string }>) {
  const c = useTheme();
  return <View style={{ gap: spacing.xs, marginTop: spacing.md }}><Text accessibilityRole="header" style={{ ...typography.heading, color: c.text }}>{title}</Text>{children}</View>;
}
