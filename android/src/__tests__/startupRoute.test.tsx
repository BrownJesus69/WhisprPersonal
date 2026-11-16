// Regression: the release APK opened on "Unmatched Route" (whisprpersonal:///) when signed out,
// because "/" only existed inside the protected (app) group. The (auth) group now owns "/" too.
import { useSyncExternalStore } from 'react';
import { Stack } from 'expo-router';
import { act, renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';
import * as AuthLayout from '@/app/(auth)/_layout';
import * as Welcome from '@/app/(auth)/index';

// babel-jest hoists this above the imports: use the real router, not jest.setup's mock.
jest.unmock('expo-router');

let signedIn = false;
const listeners = new Set<() => void>();
const setSignedIn = (value: boolean) => { signedIn = value; listeners.forEach(l => l()); };
const useSignedIn = () => useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => signedIn);

// Mirrors the guard structure of src/app/_layout.tsx.
function Root() {
  const isSignedIn = useSignedIn();
  return <Stack>
    <Stack.Protected guard={!isSignedIn}><Stack.Screen name="(auth)" /></Stack.Protected>
    <Stack.Protected guard={isSignedIn}><Stack.Screen name="(app)" /></Stack.Protected>
  </Stack>;
}

const routes = {
  _layout: Root,
  '(auth)/_layout': AuthLayout,
  '(auth)/index': Welcome,
  '(auth)/sign-in': () => <Text>sign-in-screen</Text>,
  '(app)/_layout': () => <Stack />,
  '(app)/index': () => <Text>events-screen</Text>,
};
const WELCOME = 'Be present. Keep the words.';

async function start(initial: boolean) {
  signedIn = initial;
  const r = await renderRouter(routes as never, { initialUrl: '/' });
  await act(async () => {});
  return r;
}

it('opens the welcome screen, not an unmatched route, when signed out', async () => {
  const r = await start(false);
  expect(r.queryByText(/Unmatched/)).toBeNull();
  expect(r.getSegments()).toEqual(['(auth)']);
  expect(r.getByText(WELCOME)).toBeTruthy();
});

it('opens the events screen when signed in', async () => {
  const r = await start(true);
  expect(r.getSegments()).toEqual(['(app)']);
  expect(r.getByText('events-screen')).toBeTruthy();
});

it('moves to the events screen after signing in', async () => {
  const r = await start(false);
  await act(async () => setSignedIn(true));
  expect(r.getByText('events-screen')).toBeTruthy();
  expect(r.queryByText(WELCOME)).toBeNull();
});

it('returns to the welcome screen after signing out', async () => {
  const r = await start(true);
  await act(async () => setSignedIn(false));
  expect(r.queryByText(/Unmatched/)).toBeNull();
  expect(r.getByText(WELCOME)).toBeTruthy();
});
