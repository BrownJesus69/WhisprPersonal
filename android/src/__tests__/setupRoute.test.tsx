import { act, renderRouter } from 'expo-router/testing-library';
import { Stack } from 'expo-router';
import { Text } from 'react-native';
import AppLayout from '@/app/(app)/_layout';
import { defaults, useSettingsStore } from '@/state/settingsStore';
jest.unmock('expo-router');
test('signed-in app redirects pending setup once and stays on Speak after completion', async () => {
  useSettingsStore.setState(defaults);
  const r = await renderRouter({
    _layout: () => <Stack />,
    '(app)/_layout': AppLayout,
    '(app)/index': () => <Text>speak-screen</Text>,
    '(app)/history': () => <Text>history-screen</Text>,
    '(app)/settings': () => <Text>settings-screen</Text>,
    'setup/index': () => <Text>setup-screen</Text>,
  }, { initialUrl: '/' });
  expect(r.getByText('setup-screen')).toBeTruthy();
  await act(async () => { useSettingsStore.getState().set({ onboarding: 'done' }); });
  const { router } = jest.requireActual('expo-router');
  await act(async () => { router.replace('/'); });
  expect(r.getByText('speak-screen')).toBeTruthy();
  expect(r.queryByText('setup-screen')).toBeNull();
});
