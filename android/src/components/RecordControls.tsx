import { View, Alert } from 'react-native';
import { Button } from './Button';
import type { RecordingPhase } from '@/lib/session/recordingStore';
import { spacing } from '@/theme';

export function RecordControls({ phase, busy, start, pause, resume, stop, recovered = false }: {
  phase: RecordingPhase; busy: boolean; start: () => void; pause: () => void; resume: () => void; stop: () => void; recovered?: boolean;
}) {
  return <View style={{ gap: spacing.sm }}>
    {['idle','ready','requesting_permission'].includes(phase) && <Button large label={recovered ? 'Resume recording' : 'Start recording'} loading={busy} onPress={start} />}
    {phase === 'recording' && <Button large label="Pause recording" loading={busy} onPress={pause} />}
    {phase === 'paused' && <Button large label="Resume recording" loading={busy} onPress={resume} />}
    {(['recording','paused','stopping','error'].includes(phase) || recovered) && <Button large secondary label={recovered ? 'Finish session' : 'Stop recording'} disabled={busy} onPress={() => Alert.alert('Stop this session?', 'Saved audio will continue uploading to your laptop.', [{ text: 'Keep session', style: 'cancel' }, { text: 'Stop', style: 'destructive', onPress: stop }])} />}
  </View>;
}
