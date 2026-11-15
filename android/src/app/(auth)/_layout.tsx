import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

export const unstable_settings = { initialRouteName: 'welcome' };

export default function AuthLayout() {
  const t = useTheme();
  return <Stack screenOptions={{ headerStyle: { backgroundColor: t.background }, headerTintColor: t.text, contentStyle: { backgroundColor: t.background } }}>
    <Stack.Screen name="welcome" options={{ title: 'WhisprPersonal' }} />
    <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
    <Stack.Screen name="sign-up" options={{ title: 'Create account' }} />
    <Stack.Screen name="reset-password" options={{ title: 'Reset password' }} />
  </Stack>;
}
