import { useState } from 'react';
import { useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, light, dark } from '@/theme';
import { AuthGate } from '@/components/AuthGate';
import { useAuthStore } from '@/state/authStore';

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const signedIn = useAuthStore(s => s.status === 'signed_in');
  const isDark = useColorScheme() === 'dark';
  const theme = isDark ? dark : light;
  return <SafeAreaProvider>
    <QueryClientProvider client={client}>
      <ThemeContext.Provider value={theme}>
        <StatusBar style={isDark ? 'light' : 'dark'} />
        <AuthGate>
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
            </Stack.Protected>
          </Stack>
        </AuthGate>
      </ThemeContext.Provider>
    </QueryClientProvider>
  </SafeAreaProvider>;
}
