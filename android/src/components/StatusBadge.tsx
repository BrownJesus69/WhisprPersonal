import { Text } from 'react-native';
import type { EventStatus } from '@/types/models';
import { useTheme, typography } from '@/theme';

export function StatusBadge({ status }: {
  status: EventStatus;
}) {
  const t = useTheme();
  const color = {
    draft: t.muted,
    active: t.success,
    processing: t.info,
    completed: t.primary,
    failed: t.danger
  }[status];
  return <Text accessibilityLabel={`Status: ${status}`} style={{ ...typography.label, color }}>
    {status.charAt(0).toUpperCase() + status.slice(1)}
  </Text>;
}
