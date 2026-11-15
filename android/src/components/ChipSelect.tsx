import { View } from 'react-native';
import { Button } from './Button';
import { spacing } from '@/theme';

export function ChipSelect<T extends string>({ options, selected, onSelect }: {
  options: readonly {
    value: T;
    label: string;
  }[];
  selected: readonly T[];
  onSelect: (value: T) => void;
}) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }}>
    {options.map(o => <Button
      key={o.value}
      label={`${selected.includes(o.value) ? '✓ ' : ''}${o.label}`}
      secondary={!selected.includes(o.value)}
      selected={selected.includes(o.value)}
      onPress={() => onSelect(o.value)}
    />)}
  </View>;
}
