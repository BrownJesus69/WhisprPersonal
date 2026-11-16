import { useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import { LANGUAGES, type LanguageMode } from '@/types/models';
import { useSettingsStore } from '@/state/settingsStore';
import { useTheme, typography } from '@/theme';
import { fontFor } from '@/theme/fonts';
import { t } from '@/i18n';
import { BottomSheet } from './BottomSheet';
export function LanguageSheet({ visible, close }: { visible: boolean; close: () => void }) {
  const settings = useSettingsStore(), c = useTheme(), [search, setSearch] = useState('');
  const choices: LanguageMode[] = ['auto', ...LANGUAGES.map(l => l.code)];
  const select = (mode: LanguageMode) => { settings.set({ defaultLanguageMode: mode, recentLanguages: [mode, ...settings.recentLanguages.filter(l => l !== mode)].slice(0,3) }); close(); };
  const row = (mode: LanguageMode, prefix: string) => <Pressable key={prefix + mode} accessibilityRole="button" accessibilityLabel={t(mode)} accessibilityState={{ selected: settings.defaultLanguageMode === mode }} onPress={() => select(mode)} style={{ minHeight: 48, justifyContent: 'center', paddingVertical: 12 }}>
    <Text style={{ ...typography.body, lineHeight: 26, color: c.text, fontFamily: fontFor(t(mode)) }}>{t(mode)}</Text>
    {mode === 'auto' && <Text style={{ ...typography.caption, color: c.muted }}>{t('autoHelp')}</Text>}
  </Pressable>;
  return <BottomSheet title={t('language')} visible={visible} close={close}>
    <TextInput accessibilityLabel={t('searchLanguages')} placeholder={t('searchLanguages')} placeholderTextColor={c.muted} value={search} onChangeText={setSearch} style={{ minHeight: 48, color: c.text, ...typography.body, backgroundColor: c.subtle, padding: 12, borderRadius: 12 }} />
    {!search && settings.recentLanguages.length > 0 && <><Text style={{ ...typography.label, color: c.muted }}>{t('recent')}</Text>{settings.recentLanguages.map(l => row(l, 'recent'))}</>}
    {choices.filter(l => t(l).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(l => row(l, 'all'))}
  </BottomSheet>;
}
export function LanguageChip() {
  const [visible, setVisible] = useState(false), mode = useSettingsStore(s => s.defaultLanguageMode), c = useTheme();
  const label = t('languageChip', { name: t(mode) });
  return <><Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setVisible(true)} style={{ alignSelf: 'flex-start', minHeight: 48, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: c.subtle, borderRadius: 24 }}>
    <Text style={{ ...typography.label, lineHeight: 24, color: c.text, fontFamily: fontFor(label, 600) }}>{label}</Text>
  </Pressable><LanguageSheet visible={visible} close={() => setVisible(false)} /></>;
}
