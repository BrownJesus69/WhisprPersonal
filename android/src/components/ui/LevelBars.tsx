import { useEffect, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useRecordingStore } from '@/lib/session/recordingStore';
import { useTheme } from '@/theme';
export function LevelBars({ recording }: { recording: boolean }) {
  const c = useTheme();
  const [levels, setLevels] = useState<number[]>(Array(24).fill(0));
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; listener.remove(); };
  }, []);
  useEffect(() => useRecordingStore.subscribe((current, previous) => {
    if (current.phase !== 'recording' || current.sessionId !== previous.sessionId) { setLevels(Array(24).fill(0)); return; }
    if (current.dbfs !== previous.dbfs || current.elapsedMs !== previous.elapsedMs) setLevels(old => [...old.slice(1), Math.max(0, Math.min(1, (current.dbfs + 60) / 60))]);
  }), []);
  return <View accessible={false} style={{ height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
    {(reduced ? [recording ? levels[23] : 0] : recording ? levels : Array(24).fill(0)).map((level, index) => <View key={index} style={{ width: reduced ? 96 : 3, height: reduced ? 4 : 2 + level * 28, backgroundColor: recording ? c.record : c.border, borderRadius: 2, opacity: reduced ? 0.4 + level * 0.6 : 1 }} />)}
  </View>;
}
