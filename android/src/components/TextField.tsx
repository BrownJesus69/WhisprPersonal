import { useState } from 'react';
import { Text, TextInput, View, type TextInputProps } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

export function TextField({ label, ...props }: TextInputProps & {
  label: string;
}) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return <View style={{ gap: spacing.xs }}>
    <Text style={{ ...typography.label, color: t.text }}>
      {label}
    </Text>
    <TextInput
      {...props}
      accessibilityLabel={label}
      placeholderTextColor={t.muted}
      onFocus={event => { setFocused(true); props.onFocus?.(event); }}
      onBlur={event => { setFocused(false); props.onBlur?.(event); }}
      style={[{
        minHeight: 56,
        borderWidth: 1,
        borderColor: focused ? t.primary : t.border,
        borderRadius: 16,
        padding: spacing.sm,
        color: t.text,
        backgroundColor: t.surface,
        ...typography.body
      }, props.multiline && { minHeight: 112, textAlignVertical: 'top' }]}
    />
  </View>;
}
