import { useState, useEffect, useRef } from 'react';
import { AudioRecorderProvider, useSharedAudioRecorder } from '@siteed/audio-studio';
import { recorderAdapter } from '@/lib/audio/recorder';
import { attachRecorder, useRecordingStore } from '@/lib/session/recordingStore';
import { repositories } from '@/lib/db/repositories';
import { recoverSessions } from '@/lib/session/recovery';
import { uploadService } from '@/lib/upload/uploadService';
import { useSettingsStore } from '@/state/settingsStore';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, light, dark } from '@/theme';
import { AuthGate } from '@/components/AuthGate';
import { Banner } from '@/components/Banner';
import { useAuthStore, type AppUser } from '@/state/authStore';

function RecordingRuntime() {
  const native = useSharedAudioRecorder();
  const ref = useRef(native);
  useEffect(() => { ref.current = native; }, [native]);
  const user = useAuthStore(s => s.user);
  const uid = user?.uid;
  const url = useSettingsStore(s => s.serverUrl);
  const [recoveredOwner, setRecoveredOwner] = useState<AppUser | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  useEffect(() => { attachRecorder(recorderAdapter(() => ref.current)); }, []);
  useEffect(() => {
    if (!uid) return;
    let disposed = false;
    void uploadService.stop().then(repositories).then(async repo => {
      if (disposed) return;
      if (!disposed) setRecoveryError(false);
      const state = useRecordingStore.getState();
      const live = ref.current.isRecording || ref.current.isPaused ? state.sessionId : null;
      await recoverSessions(repo, uid, live);
      if (!disposed) setRecoveredOwner(user);
    }).catch(() => { if (!disposed) setRecoveryError(true); });
    return () => { disposed = true; };
  }, [uid, user]);
  useEffect(() => {
    let disposed = false;
    if (uid && recoveredOwner === user && url) void uploadService.start(uid).catch(() => { if (!disposed) setRecoveryError(true); });
    return () => { disposed = true; void uploadService.stop(); };
  }, [uid, user, url, recoveredOwner]);
  useEffect(() => {
    const recording = useRecordingStore.getState();
    if (['recording','paused','error'].includes(recording.phase)) {
      void repositories().then(async repo => {
        const session = recording.sessionId ? await repo.session(recording.sessionId) : null;
        if (session && session.owner_uid !== uid) await recording.stop();
      }).catch(() => { setRecoveryError(true); });
    }
  }, [uid]);
  return recoveryError ? <Banner error message="Local audio recovery needs attention. Reopen the app to retry. Saved files are retained." /> : null;
}

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const signedIn = useAuthStore(s => s.status === 'signed_in');
  const isDark = useColorScheme() === 'dark';
  const theme = isDark ? dark : light;
  return <SafeAreaProvider>
    <AudioRecorderProvider><QueryClientProvider client={client}>
      <ThemeContext.Provider value={theme}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <AuthGate>
          <RecordingRuntime />
          <Stack screenOptions={{ headerStyle: { backgroundColor: theme.background }, headerTintColor: theme.text, contentStyle: { backgroundColor: theme.background } }}>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            </Stack.Protected>
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="connect" options={{ title: 'Connect laptop' }} />
              <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan laptop QR' }} />
              <Stack.Screen name="events/new" options={{ title: 'New event' }} />
              <Stack.Screen name="events/[eventId]" options={{ title: 'Event' }} />
              <Stack.Screen name="session/[sessionId]" options={{ title: 'Recording session' }} />
            </Stack.Protected>
          </Stack>
        </AuthGate>
      </ThemeContext.Provider>
    </QueryClientProvider></AudioRecorderProvider>
  </SafeAreaProvider>;
}
