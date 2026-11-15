import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, getIdToken, signOut } from '@react-native-firebase/auth';

export const auth = {
  signIn: (email: string, password: string) => signInWithEmailAndPassword(getAuth(), email.trim(), password),
  signUp: (email: string, password: string) => createUserWithEmailAndPassword(getAuth(), email.trim(), password),
  reset: (email: string) => sendPasswordResetEmail(getAuth(), email.trim()),
  signOut: () => signOut(getAuth()),
  subscribe: (callback: Parameters<typeof onAuthStateChanged>[1]) => onAuthStateChanged(getAuth(), callback),
  current: () => getAuth().currentUser,
  async idToken(force = false) {
    const user = getAuth().currentUser;
    if (!user)
      throw new Error('Sign in to continue');
    return getIdToken(user, force);
  }
};

export function authMessage(error: unknown): string {
  const code = (error as {
    code?: string;
  })?.code;
  return code === 'auth/operation-not-allowed' ? 'Enable Email/Password in the Firebase console' : code === 'auth/network-request-failed' ? 'Reconnect to the internet to sign in' : code === 'auth/email-already-in-use' ? 'This email already has an account' : code === 'auth/weak-password' ? 'Use a password with at least 6 characters' : 'Sign-in could not be completed. Check your details and try again.';
}
