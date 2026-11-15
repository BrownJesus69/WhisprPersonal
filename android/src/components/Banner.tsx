import { Text } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function Banner({ message, error = false }: {
  message: string;
  error?: boolean;
}) {
  const t = useTheme();
  return <Text accessibilityRole={error ? 'alert' : 'text'} accessibilityLiveRegion="polite" style={{
    ...typography.body,
    padding: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: error ? t.danger : t.border,
    color: error ? t.danger : t.text
  }}>
    {message}
  </Text>;
}
