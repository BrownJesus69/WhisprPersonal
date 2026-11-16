import { Text, View } from 'react-native';
import { useTheme, typography } from '@/theme';
import { Button } from '../Button';
export function InlineNotice({ title, safety, action, onPress }: { title: string; safety: string; action: string; onPress: () => void }) {
  const c = useTheme();
  return <View accessibilityLiveRegion="polite" style={{ alignSelf: 'stretch', padding: 16, borderRadius: 16, gap: 8, backgroundColor: c.subtle }}>
    <Text style={{ ...typography.body, color: c.text }}>{title}</Text>
    <Text style={{ ...typography.caption, color: c.muted }}>{safety}</Text>
    <Button secondary label={action} onPress={onPress} />
  </View>;
}
