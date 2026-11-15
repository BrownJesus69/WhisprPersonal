import { router } from 'expo-router';
import { useConnectionStore } from '@/state/connectionStore';
import { Button } from './Button';

export function ConnectionPill() {
  const status = useConnectionStore(s => s.status);
  return <Button secondary label={`Laptop · ${status.replaceAll('_', ' ')} ›`} onPress={() => router.push('/connect')} />;
}
