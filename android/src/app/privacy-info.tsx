import { Text } from 'react-native';
import { Screen } from '@/components/Screen';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';
export default function PrivacyInfo() {
  const c = useTheme();
  return <Screen title={t('privacy')}>{(['privacyAudio', 'privacyText', 'privacyNotes', 'privacyCleanup', 'privacyAds'] as const).map(key => <Text key={key} style={{ ...typography.body, color: c.text }}>{t(key)}</Text>)}</Screen>;
}
