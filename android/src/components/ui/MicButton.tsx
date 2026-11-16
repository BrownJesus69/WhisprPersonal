import { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Pressable, Text, View } from 'react-native';
import { useTheme, typography } from '@/theme';
import { t } from '@/i18n';
export function MicButton({ state, onPress, elapsed }: { state: 'ready' | 'listening' | 'processing' | 'complete'; onPress: () => void; elapsed?: string }) {
  const c = useTheme();
  const [scale] = useState(() => new Animated.Value(1));
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; listener.remove(); };
  }, []);
  const busy = state === 'processing';
  const label = t(state === 'ready' ? 'start' : state === 'listening' ? 'stop' : state === 'complete' ? 'again' : 'processing');
  const foreground = state === 'listening' ? c.onRecord : c.onPrimary;
  const feedback = (value: number) => Animated.timing(scale, { toValue: value, duration: reduced ? 0 : 150, useNativeDriver: true }).start();
  return <View style={{ alignItems: 'center', gap: 8 }}>
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={state === 'listening' ? elapsed : undefined} accessibilityState={{ disabled: busy, busy }} disabled={busy} onPress={onPress}
        onPressIn={() => feedback(0.95)} onPressOut={() => feedback(1)}
        style={{ width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: state === 'listening' ? c.record : c.primary }}>
        {busy ? <ActivityIndicator color={foreground} /> : state === 'listening' ? <View style={{ width: 24, height: 24, borderRadius: 3, backgroundColor: foreground }} /> :
          <View accessible={false} style={{ alignItems: 'center' }}><View style={{ width: 14, height: 25, borderRadius: 8, backgroundColor: foreground }} /><View style={{ width: 24, height: 17, borderWidth: 2, borderTopWidth: 0, borderColor: foreground, borderBottomLeftRadius: 14, borderBottomRightRadius: 14, marginTop: -12 }} /><View style={{ width: 2, height: 7, backgroundColor: foreground }} /></View>}
      </Pressable>
    </Animated.View>
    <Text style={{ ...typography.label, color: c.text }}>{label}</Text>
  </View>;
}
