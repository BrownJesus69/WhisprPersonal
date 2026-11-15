import { config, FeatureDisabledError } from '@/lib/config';

export async function signInWithGoogle() {
  if (!config.features.googleSignIn || !process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID)
    throw new FeatureDisabledError();
  const { GoogleSignin } = await import('@react-native-google-signin/google-signin');
  const { getAuth, GoogleAuthProvider, signInWithCredential } = await import('@react-native-firebase/auth');
  GoogleSignin.configure({ webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID });
  await GoogleSignin.hasPlayServices();
  const response = await GoogleSignin.signIn();
  if (response.type !== 'success')
    return;
  if (!response.data.idToken)
    throw new Error('Google sign-in did not return an ID token');
  return signInWithCredential(getAuth(), GoogleAuthProvider.credential(response.data.idToken));
}
