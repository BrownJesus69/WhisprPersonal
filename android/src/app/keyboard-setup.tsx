import { fontFor, lineHeightFor } from '@/theme/fonts';
import { useEffect, useState } from 'react';
import { AppState, Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import keyboard from '../../modules/whispr-keyboard';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { SettingsGroup } from '@/components/ui/SettingsGroup';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

export default function KeyboardSetup() {
  const c = useTheme();
  const [system, setSystem] = useState({ enabled: false, selected: false });
  const [error, setError] = useState(false), [sample, setSample] = useState('');
  useEffect(() => {
    let active = true, generation = 0;
    const check = () => {
      const current = ++generation;
      void Promise.all([keyboard.isEnabled(), keyboard.isSelected()]).then(([enabled, selected]) => {
        if (active && current === generation) { setSystem({ enabled, selected }); setError(false); }
      }).catch(() => { if (active && current === generation) setError(true); });
    };
    check();
    const sub = AppState.addEventListener('change', state => { if (state === 'active') check(); });
    return () => { active = false; sub.remove(); };
  }, []);
  const action = (fn: () => Promise<void>) => { void fn().catch(() => setError(true)); };
  return <Screen title={t('keyboardSetup')}>
    {error && <Text accessibilityRole="alert" style={{ ...typography.body, color: c.danger }}>{t('keyboardUnavailable')}</Text>}
    <SettingsGroup title={t('keyboardEnable')}>
      <Text style={{ ...typography.body, color: c.text }}>{t('keyboardWarning')}</Text>
      <Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: c.text }}>{system.enabled ? `✓ ${t('keyboardEnabled')}` : t('keyboardPending')}</Text>
      <Button label={t('keyboardOpenSettings')} onPress={() => action(() => keyboard.openInputMethodSettings())} />
    </SettingsGroup>
    <SettingsGroup title={t('keyboardSwitch')}>
      <Text accessibilityLiveRegion="polite" style={{ ...typography.body, color: c.text }}>{system.selected ? `✓ ${t('keyboardSelected')}` : t('keyboardPending')}</Text>
      <Button label={t('keyboardChoose')} onPress={() => action(() => keyboard.showPicker())} />
    </SettingsGroup>
    <SettingsGroup title={t('keyboardTry')}>
      <TextInput accessibilityLabel={t('keyboardTest')} placeholder={t('keyboardTest')} placeholderTextColor={c.muted} value={sample} onChangeText={setSample} multiline style={{ ...typography.body, fontFamily: fontFor(sample), lineHeight: lineHeightFor(sample, 16), color: c.text, backgroundColor: c.surface, minHeight: 80, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12 }} />
      {!!sample.trim() && system.enabled && system.selected && <Text style={{ ...typography.body, color: c.text }}>✓ {t('keyboardTestDone')}</Text>}
    </SettingsGroup>
    <Button secondary label={t('notNow')} onPress={() => router.back()} />
  </Screen>;
}
