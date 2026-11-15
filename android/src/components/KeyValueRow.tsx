import { View, Text } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function KeyValueRow({ label, value, selectable = false }: {
  label: string;
  value: unknown;
  selectable?: boolean;
}) {
  const t = useTheme();
  return <View style={{ gap: spacing.xs }}>
    <Text style={{ ...typography.label, color: t.muted }}>
      {label}
    </Text>
    <Text selectable={selectable} style={{ ...typography.body, color: t.text }}>
      {value === null || value === undefined ? 'Unknown' : String(value)}
    </Text>
  </View>;
}
