import { Children, type PropsWithChildren } from 'react';
import { View } from 'react-native';
import { spacing } from '@/theme';

/** Lays buttons side by side with equal widths. */
export function ButtonRow({ children }: PropsWithChildren) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
    {Children.toArray(children).filter(Boolean).map((child, i) => <View key={i} style={{ flexGrow: 1, flexBasis: 140 }}>{child}</View>)}
  </View>;
}
