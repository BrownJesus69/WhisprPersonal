import type { PropsWithChildren } from 'react';
import { ScrollView, Text, KeyboardAvoidingView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, typography, spacing } from '@/theme';

export function Screen({ title, children }: PropsWithChildren<{
  title: string;
}>) {
  const t = useTheme();
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: t.background }}>
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl }}>
        <Text accessibilityRole="header" style={{ ...typography.title, color: t.text }}>
          {title}
        </Text>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
