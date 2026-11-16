import { router } from 'expo-router';
import { Screen } from '@/components/Screen';
import { ConnectComputer } from '@/features/connect/ConnectComputer';
import { t } from '@/i18n';
export default function Connect() {
  return <Screen title={t('connect')}><ConnectComputer onConnected={() => router.back()} /></Screen>;
}
