import { Children, type PropsWithChildren } from 'react';
import { View } from 'react-native';
import { spacing } from '@/theme';

/** Lays buttons side by side with equal widths. */
export function ButtonRow({ children }: PropsWithChildren) {
  return <View style={{ flexDirection: 'row', gap: spacing.xs }}>
    {Children.toArray(children).filter(Boolean).map((child, i) => <View key={i} style={{ flex: 1 }}>{child}</View>)}
  </View>;
}
