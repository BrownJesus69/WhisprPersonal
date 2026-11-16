import { ActivityIndicator, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useConnectComputer } from './useConnectComputer';
import { TextField } from '@/components/TextField';
import { Button } from '@/components/Button';
import { Collapsible } from '@/components/Collapsible';
import { HealthPanel } from '@/components/HealthPanel';
import { KeyValueRow } from '@/components/KeyValueRow';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';

export function ConnectComputer({ onConnected }: { onConnected?: (ready: boolean) => void }) {
  const s = useConnectComputer(onConnected), c = useTheme();
  const labels = ['reachable', 'accepted', 'recognitionReady'] as const;
  return <>
    <Text style={{ ...typography.body, color: c.muted }}>{t('computerNote')}</Text>
    <TextField label={t('computerAddress')} editable={!s.busy} autoCapitalize="none" autoCorrect={false} value={s.address} onChangeText={value => { s.setAddress(value); s.setMessage(''); }} />
    <Button secondary label={t('scanQR')} disabled={s.busy} onPress={() => router.push('/scan')} />
    <TextField label={t('serverKey')} editable={!s.busy} secureTextEntry autoCapitalize="none" autoCorrect={false} value={s.key} onChangeText={value => { s.setKey(value); s.setMessage(''); }} />
    {labels.map((label, i) => <View key={label} style={{ minHeight: 48, gap: 8, flexDirection: 'row', alignItems: 'center' }}>
      {s.checks[i] === 'checking' && <ActivityIndicator />}
      <View style={{ flex: 1 }}>
        <Text style={{ ...typography.body, color: c.text }}>{t(label)}</Text>
        {i === 1 && s.checks[i] === 'passed' && <Text style={{ ...typography.caption, color: c.muted }}>{t('authSignedIn')}</Text>}
        <Text accessibilityLiveRegion="polite" style={{ ...typography.caption, color: c.muted }}>
          {s.checks[i] === 'passed' ? `✓ ${t('passed')}` : s.checks[i] === 'failed' ? `× ${i === 2 ? t(s.health.data?.model.status === 'loading' ? 'stillLoading' : 'recognitionNotReady') : s.message || t('checkFailed')}` : t(s.checks[i])}
        </Text>
      </View>
    </View>)}
    <Button large label={s.checks[2] === 'failed' ? t('checkAgain') : t('connectAction')} disabled={!s.address.trim() || s.retryAt > 0} loading={s.busy} onPress={() => void s.connect()} />
    {!!s.message && <InlineNotice title={s.message} safety={t('connectionSafety')} action={t('retry')} onPress={() => void s.connect()} />}
    {s.health.data && <Collapsible title={t('laptopDetails')}>
      <HealthPanel health={s.health.data} />
      {s.message.includes('not allowed') && <><KeyValueRow label={t('allowedUID')} value={s.connection.check?.uid ?? s.uid} selectable /><Text style={{ ...typography.body, color: c.text }}>{t('allowlistHelp')}</Text></>}
      {s.connection.check && <KeyValueRow label={t('signedInAs')} value={s.connection.check.uid} selectable />}
    </Collapsible>}
  </>;
}
