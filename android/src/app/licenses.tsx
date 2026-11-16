import { Text } from 'react-native';
import { Screen } from '@/components/Screen';
import { SettingsRow } from '@/components/ui/SettingsRow';
import licenses from '@/generated/licenses.json';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';
export default function Licenses() {
  const c = useTheme();
  return <Screen title={t('licenses')}>
    <Text style={{ ...typography.body, color: c.text }}>{t('fontLicenses')}</Text>
    {licenses.map(entry => <SettingsRow key={entry.name} title={entry.name} description={entry.license} />)}
  </Screen>;
}
