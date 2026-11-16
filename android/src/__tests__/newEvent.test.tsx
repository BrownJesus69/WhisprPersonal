import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { setDoc } from '@react-native-firebase/firestore';
import NewEvent from '@/app/events/new';
import { useAuthStore } from '@/state/authStore';
import { useSettingsStore, defaults } from '@/state/settingsStore';

beforeEach(() => {
  useSettingsStore.setState({ ...defaults, privacyMode: 'local_only', defaultLanguageMode: 'auto' });
  useAuthStore.setState({ user: { uid: 'owner', email: 'o@example.test', provider: 'password' } as never, status: 'signed_in' } as never);
});

test('a name is all that is needed; optional details stay hidden', async () => {
  const view = await render(<NewEvent />);
  expect(view.getByLabelText('Create event')).toBeDisabled();
  expect(view.queryByLabelText('Location')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('Event name'), 'Board meeting');
  expect(view.getByLabelText('Create event')).toBeEnabled();
});

test('one language choice sets both the mode and the expected language', async () => {
  const view = await render(<NewEvent />);
  await fireEvent.changeText(view.getByLabelText('Event name'), 'Board meeting');
  await fireEvent.press(view.getByLabelText('Kannada'));
  await fireEvent.press(view.getByLabelText('More details (optional)'));
  await fireEvent.changeText(view.getByLabelText('Speakers (separate with commas)'), 'Asha, , Ravi ');
  await fireEvent.press(view.getByLabelText('Create event'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: '/events/[eventId]', params: { eventId: 'event-1' } }));
  expect(jest.mocked(setDoc).mock.calls[0][1]).toMatchObject({
    ownerId: 'owner', title: 'Board meeting', languageMode: 'kn', languages: ['kn'], speakers: ['Asha', 'Ravi'],
    privacyMode: 'local_only', startTime: null, endTime: null
  });
});
