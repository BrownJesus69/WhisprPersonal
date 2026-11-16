import { useSettingsStore } from '@/state/settingsStore';
import { fontFor } from '@/theme/fonts';
import { t as text } from '@/i18n';
import { Tabs, Redirect } from 'expo-router';
import { Text } from 'react-native';
import { useTheme } from '@/theme';

export default function AppLayout() {
  const t = useTheme();
  const onboarding = useSettingsStore(s => s.onboarding);
  if (onboarding === 'pending') return <Redirect href="/setup" />;
  return <Tabs screenOptions={{
    tabBarLabelStyle: { fontFamily: fontFor('', 600) },
    headerTitleStyle: { fontFamily: fontFor('', 700) },
    tabBarActiveTintColor: t.primary,
    tabBarInactiveTintColor: t.muted,
    tabBarStyle: { backgroundColor: t.surface, minHeight: 64 },
    headerStyle: { backgroundColor: t.background },
    headerTintColor: t.text
  }}>
    <Tabs.Screen name="index" options={{ title: text('speak'), headerShown: false, tabBarIcon: ({ color }) => <Text style={{ color }}>◷</Text> }} />
    <Tabs.Screen name="history" options={{ title: text('history'), tabBarIcon: ({ color }) => <Text style={{ color }}>≡</Text> }} />
    <Tabs.Screen name="settings" options={{ title: text('settings'), tabBarIcon: ({ color }) => <Text style={{ color }}>⚙</Text> }} />
  </Tabs>;
}
