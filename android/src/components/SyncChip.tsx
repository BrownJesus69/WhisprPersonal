import { Text } from 'react-native';
import { typography, useTheme } from '@/theme';
import type { SyncState } from '@/lib/notes/model';

const labels: Record<SyncState, string> = { pending: 'Saved on phone · syncing', synced: 'Synced', conflict: 'Conflict', failed: 'Not saved to cloud' };
export function SyncChip({ state }: { state: SyncState }) {
  const t = useTheme();
  return <Text accessibilityLabel={labels[state]} style={{ ...typography.label, color: state === 'conflict' || state === 'failed' ? t.danger : t.muted }}>{labels[state]}</Text>;
}
