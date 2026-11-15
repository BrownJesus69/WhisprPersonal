import { Card } from './Card';
import { Banner } from './Banner';
import { Button } from './Button';

export function EmptyState({ message, label, onPress }: {
  message: string;
  label?: string;
  onPress?: () => void;
}) {
  return <Card>
    <Banner message={message} />
    {label && onPress && <Button label={label} onPress={onPress} />}
  </Card>;
}
