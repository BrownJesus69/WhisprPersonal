import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { FeatureDisabledError } from '@/lib/config';
import { signInWithGoogle } from '@/lib/firebase/google';

test('disabled Google sign-in never configures or calls the native provider', async () => {
  await expect(signInWithGoogle()).rejects.toBeInstanceOf(FeatureDisabledError);
  expect(GoogleSignin.configure).not.toHaveBeenCalled();
  expect(GoogleSignin.signIn).not.toHaveBeenCalled();
});
