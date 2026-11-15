import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useTheme } from '@/theme';

export default function AppLayout() {
  const t = useTheme();
  return <Tabs screenOptions={{
    tabBarActiveTintColor: t.primary,
    tabBarInactiveTintColor: t.muted,
    tabBarStyle: { backgroundColor: t.surface, minHeight: 64 },
    headerStyle: { backgroundColor: t.background },
    headerTintColor: t.text
  }}>
    <Tabs.Screen name="index" options={{ title: 'Events', tabBarIcon: ({ color }) => <Text style={{ color }}>◷</Text> }} />
    <Tabs.Screen name="library" options={{ title: 'Library', tabBarIcon: ({ color }) => <Text style={{ color }}>▤</Text> }} />
    <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ({ color }) => <Text style={{ color }}>⚙</Text> }} />
  </Tabs>;
}
