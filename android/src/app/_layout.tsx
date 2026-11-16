import { startKeyboardSync } from '@/features/keyboard/syncKeyboard';
import { applySpeakRetention } from '@/features/speak/retention';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { NotoSansKannada_400Regular, NotoSansKannada_600SemiBold, NotoSansKannada_700Bold } from '@expo-google-fonts/noto-sans-kannada';
import { NotoSansTamil_400Regular, NotoSansTamil_600SemiBold, NotoSansTamil_700Bold } from '@expo-google-fonts/noto-sans-tamil';
import { NotoSansDevanagari_400Regular, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold } from '@expo-google-fonts/noto-sans-devanagari';
import { fontFor, setFontsAvailable } from '@/theme/fonts';
import { t } from '@/i18n';
import { aiRuntime } from '@/lib/ai/runtime';
import { useState, useEffect, useRef } from 'react';
import { AudioRecorderProvider, useSharedAudioRecorder } from '@siteed/audio-studio';
import { recorderAdapter } from '@/lib/audio/recorder';
import { attachRecorder, useRecordingStore } from '@/lib/session/recordingStore';
import { repositories } from '@/lib/db/repositories';
import { recoverSessions } from '@/lib/session/recovery';
import { noteSync } from '@/lib/notes/noteSync';
import { uploadService } from '@/lib/upload/uploadService';
import { liveController } from '@/lib/live/liveController';
import { useSettingsStore } from '@/state/settingsStore';
import { useColorScheme } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, light, dark } from '@/theme';
import { AuthGate } from '@/components/AuthGate';
import { Banner } from '@/components/Banner';
import { useAuthStore, type AppUser } from '@/state/authStore';

void SplashScreen.preventAutoHideAsync().catch(() => {});

function RecordingRuntime() {
  useEffect(() => { liveController.startRuntime(); return () => liveController.stopRuntime(); }, []);
  const native = useSharedAudioRecorder();
  const ref = useRef(native);
  useEffect(() => { ref.current = native; }, [native]);
  const user = useAuthStore(s => s.user);
  const uid = user?.uid;
  const url = useSettingsStore(s => s.serverUrl);
  const [aiError, setAIError] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (uid && url) void aiRuntime.start(uid).then(() => { if (!disposed) setAIError(false); }).catch(() => { if (!disposed) setAIError(true); });
    return () => { disposed = true; void aiRuntime.stop(); };
  }, [uid, url]);
  const [recoveredOwner, setRecoveredOwner] = useState<AppUser | null>(null);
  const [recoveryError, setRecoveryError] = useState(false);
  const [retentionNotice, setRetentionNotice] = useState('');
  const [noteSyncError, setNoteSyncError] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (uid) void noteSync.start(uid).then(() => { if (!disposed) setNoteSyncError(false); }).catch(() => { if (!disposed) setNoteSyncError(true); });
    return () => { disposed = true; noteSync.stop(); };
  }, [uid]);
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
      try {
        const result = await applySpeakRetention(uid, 'startup');
        if (!disposed) setRetentionNotice(result.failed ? t('retentionFailed') : result.pending ? t('deletePending') : '');
      } catch { if (!disposed) setRetentionNotice(t('retentionFailed')); }
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
  return <>
    {!!retentionNotice && <InlineNotice title={retentionNotice} safety={t('retentionSafe')} action={t('connect')} onPress={() => router.push('/connect')} />}
    {aiError && <Banner message="AI requests could not resume. Reopen the app to retry. Raw transcript is preserved." />}
    {recoveryError && <Banner error message="Local audio recovery needs attention. Reopen the app to retry. Saved files are retained." />}
    {noteSyncError && <Banner error message="Notes sync could not start. Notes stay on this phone. Reopen the app to retry." />}
  </>;
}

export default function RootLayout() {
  const [keyboardError, setKeyboardError] = useState(false);
  useEffect(() => startKeyboardSync(() => setKeyboardError(true)), []);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const signedIn = useAuthStore(s => s.status === 'signed_in');
  const [fontsLoaded, fontError] = useFonts({ Manrope_400Regular, Manrope_600SemiBold, Manrope_700Bold, NotoSansKannada_400Regular, NotoSansKannada_600SemiBold, NotoSansKannada_700Bold, NotoSansTamil_400Regular, NotoSansTamil_600SemiBold, NotoSansTamil_700Bold, NotoSansDevanagari_400Regular, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold });
  const [fontTimeout, setFontTimeout] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setFontTimeout(true), 5000); return () => clearTimeout(timer); }, []);
  const fontsReady = fontsLoaded || !!fontError || fontTimeout;
  setFontsAvailable(fontsLoaded);
  useEffect(() => { if (fontsReady) void SplashScreen.hideAsync().catch(() => {}); }, [fontsReady]);
  const appearance = useSettingsStore(s => s.appearance);
  const scheme = useColorScheme();
  const isDark = appearance === 'dark' || appearance === 'system' && scheme === 'dark';
  const theme = isDark ? dark : light;
  if (!fontsReady) return null;
  return <SafeAreaProvider>
    <AudioRecorderProvider><QueryClientProvider client={client}>
      <ThemeContext.Provider value={theme}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <AuthGate>
          <RecordingRuntime />
          {keyboardError && <Banner error message={t('keyboardSyncFailed')} />}
          <Stack screenOptions={{ headerTitleStyle: { fontFamily: fontFor('', 700) }, headerStyle: { backgroundColor: theme.background }, headerTintColor: theme.text, contentStyle: { backgroundColor: theme.background } }}>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            </Stack.Protected>
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="setup/index" options={{ title: t('setup') }} />
              <Stack.Screen name="keyboard-setup" options={{ title: t('keyboardSetup') }} />
              <Stack.Screen name="personal-words" options={{ title: t('personalWords') }} />
              <Stack.Screen name="history/[sessionId]" options={{ title: t('transcript') }} />
              <Stack.Screen name="licenses" options={{ title: t('licenses') }} />
              <Stack.Screen name="privacy-info" options={{ title: t('privacy') }} />
              <Stack.Screen name="connect" options={{ title: t('connect') }} />
              <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan laptop QR' }} />
              <Stack.Screen name="events/index" options={{ title: t('events') }} />
              <Stack.Screen name="events/new" options={{ title: 'New event' }} />
              <Stack.Screen name="events/[eventId]/index" options={{ title: 'Event' }} />
              <Stack.Screen name="events/[eventId]/brief" options={{ title: 'Briefs' }} />
              <Stack.Screen name="events/[eventId]/notes" options={{ title: 'Notes' }} />
              <Stack.Screen name="events/[eventId]/export" options={{ title: 'Export' }} />
              <Stack.Screen name="events/[eventId]/vocabulary" options={{ title: 'Vocabulary' }} />
              <Stack.Screen name="transcript/[sessionId]" options={{ title: 'Transcript' }} />
              <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
              <Stack.Screen name="search" options={{ title: 'Search' }} />
              <Stack.Screen name="session/[sessionId]" options={{ title: 'Recording session' }} />
            </Stack.Protected>
          </Stack>
        </AuthGate>
      </ThemeContext.Provider>
    </QueryClientProvider></AudioRecorderProvider>
  </SafeAreaProvider>;
}
