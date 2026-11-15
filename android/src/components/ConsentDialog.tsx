import { useState } from 'react';
import { Modal, View, Text, Switch } from 'react-native';
import { Button } from './Button';
import { useTheme, spacing, typography } from '@/theme';

export function ConsentDialog({ visible, confirm, cancel }: { visible: boolean; confirm: () => void; cancel: () => void }) {
  const [checked, setChecked] = useState(false);
  const t = useTheme();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel} onShow={() => setChecked(false)}>
    <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: '#00000099' }}>
      <View style={{ padding: spacing.lg, gap: spacing.md, backgroundColor: t.surface, borderRadius: spacing.md }}>
        <Text style={{ ...typography.title, color: t.text }}>Before recording</Text>
        <Text style={{ ...typography.body, color: t.text }}>Audio is saved on this phone and sent to your laptop. Transcripts and notes sync to Firebase. Tell every participant and obtain their permission.</Text>
        <Text style={{ ...typography.body, color: t.text }}>Everyone being recorded has been told and agrees</Text>
        <Switch accessibilityRole="checkbox" accessibilityLabel="Everyone being recorded has been told and agrees" accessibilityState={{ checked }} value={checked} onValueChange={setChecked} />
        <Button label="Confirm and start" disabled={!checked} onPress={confirm} />
        <Button secondary label="Cancel" onPress={cancel} />
      </View>
    </View>
  </Modal>;
}
