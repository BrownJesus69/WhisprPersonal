import { useState, type PropsWithChildren } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, typography, spacing } from '@/theme';

/** Hides rarely used options behind one tap, closed by default. */
export function Collapsible({ title, children, initiallyOpen = false }: PropsWithChildren<{
  title: string; initiallyOpen?: boolean;
}>) {
  const t = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  return <View style={{ gap: spacing.sm }}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)}
      style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, opacity: pressed ? 0.72 : 1 })}
    >
      <Text style={{ ...typography.label, color: t.primary }}>{open ? '▾' : '▸'}</Text>
      <Text style={{ ...typography.label, color: t.primary }}>{title}</Text>
    </Pressable>
    {open && children}
  </View>;
}
