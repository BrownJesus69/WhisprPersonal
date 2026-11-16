import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { ConnectComputer } from '@/features/connect/ConnectComputer';
import { useSettingsStore } from '@/state/settingsStore';
import { LANGUAGES, type LanguageMode } from '@/types/models';
import { useTheme, typography } from '@/theme';
import { fontFor } from '@/theme/fonts';
import { t } from '@/i18n';

export default function Setup() {
  const [step, setStep] = useState(0), settings = useSettingsStore(), c = useTheme();
  const finish = () => { settings.set({ onboarding: 'done' }); router.replace('/'); };
  const choices: LanguageMode[] = ['auto', ...LANGUAGES.map(l => l.code)];
  return <Screen title={t((['chooseLanguage', 'connectComputer', 'tryIt'] as const)[step])}>
    {step === 0 && <>
      {choices.map(mode => <Pressable key={mode} accessibilityRole="button" accessibilityLabel={t(mode)} accessibilityState={{ selected: mode === settings.defaultLanguageMode }} onPress={() => settings.set({ defaultLanguageMode: mode })} style={({ pressed }) => ({ minHeight: 48, padding: 16, borderBottomWidth: 1, borderColor: c.border, backgroundColor: pressed || mode === settings.defaultLanguageMode ? c.subtle : c.background })}>
        <Text style={{ ...typography.body, color: c.text, fontFamily: fontFor(t(mode)) }}>{t(mode)}{mode === settings.defaultLanguageMode ? ' ✓' : ''}</Text>
        {mode === 'auto' && <Text style={{ ...typography.caption, color: c.muted }}>{t('autoHelp')}</Text>}
      </Pressable>)}
      <Button label={t('next')} onPress={() => setStep(1)} />
    </>}
    {step === 1 && <ConnectComputer onConnected={ready => { if (ready) setStep(2); }} />}
    {step === 2 && <><Text style={{ ...typography.body, color: c.text }}>{t('tryHelp')}</Text><Button label={t('start')} onPress={finish} /></>}
    {step > 0 && <Button secondary label={t('back')} onPress={() => setStep(step - 1)} />}
    <Button secondary label={t('notNow')} onPress={finish} />
  </Screen>;
}
