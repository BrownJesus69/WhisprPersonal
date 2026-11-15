import { Text } from 'react-native';
import type { AIStatus } from '@/lib/ai/types';
import { providerName, providerStatus, UNAVAILABLE } from '@/lib/ai/messages';
import { useTheme, typography } from '@/theme';

export function AIProviderLine({ status }: { status?: AIStatus }) {
  const t = useTheme();
  return <Text accessibilityLiveRegion="polite" style={{ ...typography.label, color: t.muted }}>
    {status ? `${Object.entries(status.providers).map(([name,p]) => `${providerName(name)}: ${providerStatus(p.status)}`).join(' · ')}${!status.cloud_available && !status.local_available ? `\n${UNAVAILABLE}` : ''}` : 'Provider status unavailable.'}
  </Text>;
}
