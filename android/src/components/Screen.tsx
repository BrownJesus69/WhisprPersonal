import type { PropsWithChildren } from 'react';
import { ScrollView, Text, KeyboardAvoidingView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, typography, spacing, gutter } from '@/theme';

export function Screen({ title, children, scroll = true }: PropsWithChildren<{
  title: string; scroll?: boolean;
}>) {
  const t = useTheme();
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: t.background }}>
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: gutter, gap: spacing.sm, paddingBottom: spacing.xl }}>
        <Text accessibilityRole="header" style={{ ...typography.title, color: t.text }}>
          {title}
        </Text>
        {children}
      </ScrollView> : <View style={{ flex: 1, padding: gutter, gap: spacing.xs }}>
        <Text accessibilityRole="header" style={{ ...typography.heading, color: t.text }}>{title}</Text>
        {children}
      </View>}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
