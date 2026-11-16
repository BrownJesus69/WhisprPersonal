import { fontFor, lineHeightFor } from '@/theme/fonts';
import { useState } from 'react';
import { Pressable, Text, ActivityIndicator } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function Button({ label, accessibilityLabel, onPress, disabled = false, loading = false, secondary = false, selected, large = false, role = 'button' }: {
  role?: 'button' | 'tab';
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  secondary?: boolean;
  selected?: boolean;
  large?: boolean;
}) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return <Pressable
    accessibilityRole={role}
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: disabled || loading, busy: loading, selected }}
    disabled={disabled || loading}
    onPress={onPress}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    style={({ pressed }) => ({
      minHeight: large ? 64 : 48,
      maxWidth: '100%',
      padding: spacing.sm,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: focused ? t.text : secondary ? t.border : t.primary,
      backgroundColor: secondary ? t.surface : t.primary,
      opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
      flexDirection: 'row', flexWrap: 'wrap',
      gap: spacing.xs,
      alignItems: 'center',
      justifyContent: 'center'
    })}
  >
    {loading && <ActivityIndicator color={secondary ? t.primary : t.onPrimary} />}
    <Text style={{ ...typography.label, fontFamily: fontFor(label, 600), lineHeight: lineHeightFor(label, 14), flexShrink: 1, textAlign: 'center', color: secondary ? t.primary : t.onPrimary }}>
      {label}
    </Text>
  </Pressable>;
}
