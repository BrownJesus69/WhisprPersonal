import { useState } from 'react';
import { router } from 'expo-router';
import { Screen } from './Screen';
import { TextField } from './TextField';
import { Button } from './Button';
import { Banner } from './Banner';
import { auth, authMessage } from '@/lib/firebase/auth';
import { config } from '@/lib/config';

export function AuthForm({ mode }: {
  mode: 'sign-in' | 'sign-up' | 'reset';
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const label = mode === 'sign-in' ? 'Sign in' : mode === 'sign-up' ? 'Create account' : 'Send reset email';
  async function submit(google = false) {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      if (google) {
        const { signInWithGoogle } = await import('@/lib/firebase/google');
        await signInWithGoogle();
      }
      else {
        if (!email.includes('@') || (mode !== 'reset' && password.length < 6)) {
          setFailed(true);
          setMessage('Enter a valid email and a password with at least 6 characters');
          return;
        }
        if (mode === 'sign-in')
          await auth.signIn(email, password);
        else if (mode === 'sign-up')
          await auth.signUp(email, password);
        else {
          await auth.reset(email);
          setMessage('If this email has an account, a reset link will arrive shortly.');
        }
      }
    }
    catch (e) {
      setFailed(true);
      setMessage(authMessage(e));
    }
    finally {
      setBusy(false);
    }
  }
  return <Screen title={mode === 'reset' ? 'Reset password' : label}>
    <TextField
      label="Email"
      keyboardType="email-address"
      autoCapitalize="none"
      autoComplete="email"
      value={email}
      onChangeText={setEmail}
    />
    {mode !== 'reset' && <TextField
      label="Password"
      secureTextEntry
      autoCapitalize="none"
      autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
      value={password}
      onChangeText={setPassword}
    />}
    {message && <Banner message={message} error={failed} />}
    <Button label={label} loading={busy} onPress={() => void submit()} />
    {mode === 'sign-in' && <>
      <Button secondary label="Forgot password?" onPress={() => router.push('/(auth)/reset-password')} />
      <Button secondary label="Create account" onPress={() => router.push('/(auth)/sign-up')} />
      {config.features.googleSignIn && <Button
        secondary
        label="Continue with Google"
        loading={busy}
        onPress={() => void submit(true)}
      />}
    </>}
  </Screen>;
}
