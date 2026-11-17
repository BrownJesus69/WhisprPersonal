import { t } from '@/i18n';
import { useEffect } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import { useTheme, typography } from '@/theme';
import { Button } from '../Button';
/** `details` is an optional technical reason (already path-free), shown small for troubleshooting. */
export function InlineNotice({ title, safety, action, onPress, busy = false, details }: { title: string; safety: string; action: string; onPress: () => void; busy?: boolean; details?: string | null }) {
  const c = useTheme();
  useEffect(() => { AccessibilityInfo.announceForAccessibility(title); }, [title]);
  return <View style={{ alignSelf: 'stretch', padding: 16, borderRadius: 16, gap: 8, backgroundColor: c.subtle }}>
    <Text style={{ ...typography.body, color: c.text }}>{title}</Text>
    <Text style={{ ...typography.caption, color: c.muted }}>{safety}</Text>
    {!!details && <Text selectable style={{ ...typography.caption, color: c.muted }}>{t('errorDetails', { reason: details })}</Text>}
    <Button secondary label={action} loading={busy} onPress={onPress} />
  </View>;
}
