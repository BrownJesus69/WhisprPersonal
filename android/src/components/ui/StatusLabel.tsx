import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { useConnectionStore } from '@/state/connectionStore';
import type { LiveStatus } from '@/lib/live/streamClient';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';
export function StatusLabel({ live }: { live?: LiveStatus }) {
  const status = useConnectionStore(s => s.status), c = useTheme();
  const connected = ['connected', 'verified'].includes(status) && (!live || ['live','stopped'].includes(live));
  const key = live === 'reconnecting' ? 'reconnecting' : ['testing','verifying','reachable'].includes(status) || live === 'waiting_for_server' ? 'connecting' : connected ? 'connected' : 'disconnected';
  return <Pressable accessibilityRole="button" accessibilityLabel={t(key)} onPress={() => { if (!connected) router.push('/connect'); }} style={{ minHeight: 48, justifyContent: 'center' }}>
    <Text style={{ ...typography.caption, color: c.muted }}><Text style={{ color: connected ? c.success : c.muted }}>● </Text>{t(key)}</Text>
  </Pressable>;
}
