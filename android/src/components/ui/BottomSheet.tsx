import type { PropsWithChildren } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';
import { Button } from '../Button';
export function BottomSheet({ visible, title, close, children }: PropsWithChildren<{ visible: boolean; title: string; close: () => void }>) {
  const c = useTheme(), insets = useSafeAreaInsets();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000066' }}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('close')} onPress={close} style={{ flex: 1, minHeight: 48 }} />
      <View accessibilityViewIsModal style={{ maxHeight: '85%', backgroundColor: c.elevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: Math.max(20, insets.bottom) }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.border, alignSelf: 'center', marginBottom: 16 }} />
        <Text accessibilityRole="header" style={{ ...typography.heading, color: c.text }}>{title}</Text>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingVertical: 12 }}>{children}</ScrollView>
        <Button secondary label={t('close')} onPress={close} />
      </View>
    </View>
  </Modal>;
}
