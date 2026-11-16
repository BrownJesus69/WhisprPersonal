import { useEffect } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { useTheme, typography } from '@/theme';
import { Button } from '../Button';
export function InlineNotice({ title, safety, action, onPress, busy = false }: { title: string; safety: string; action: string; onPress: () => void; busy?: boolean }) {
  const c = useTheme();
  useEffect(() => { AccessibilityInfo.announceForAccessibility(title); }, [title]);
  return <View style={{ alignSelf: 'stretch', padding: 16, borderRadius: 16, gap: 8, backgroundColor: c.subtle }}>
    <Text style={{ ...typography.body, color: c.text }}>{title}</Text>
    <Text style={{ ...typography.caption, color: c.muted }}>{safety}</Text>
    <Button secondary label={action} loading={busy} onPress={onPress} />
  </View>;
}
