import { Text } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function SectionHeader({ title }: {
  title: string;
}) {
  const t = useTheme();
  return <Text accessibilityRole="header" style={{ ...typography.heading, color: t.text, marginTop: spacing.sm }}>
    {title}
  </Text>;
}
