import type { PropsWithChildren } from 'react';
import { View } from 'react-native';
import { useTheme, spacing } from '@/theme';

export function Card({ children }: PropsWithChildren) {
  const t = useTheme();
  return <View style={{
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: t.surface,
    borderRadius: 24
  }}>
    {children}
  </View>;
}
