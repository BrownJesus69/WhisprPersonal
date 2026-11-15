import { Text } from 'react-native';
import { typography, useTheme } from '@/theme';
import type { LiveStatus } from '@/lib/live/streamClient';

export function LiveStatusPill({ status, attempt }: { status: LiveStatus; attempt: number }) {
  const t = useTheme();
  const text: Record<LiveStatus, string> = {
    live: 'Live', reconnecting: `Reconnecting (${attempt})`, waiting_for_server: 'Waiting for laptop',
    offline: 'Offline — transcript will catch up', auth_required: 'Sign-in renewal needed',
    not_allowed: 'Not allowed', stopped: 'Saved transcript'
  };
  return <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...typography.label, color: status === 'live' ? t.success : t.muted }}>{text[status]}</Text>;
}
