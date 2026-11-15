import { useEffect, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useSettingsStore } from '@/state/settingsStore';
import { auth } from '@/lib/firebase/auth';
import { ensureUserDoc } from '@/lib/firebase/users';
import { renewOnForeground } from '@/lib/server/tokenManager';
import { credentials } from '@/lib/server/credentials';
import { useAuthStore } from '@/state/authStore';
import { useConnectionStore } from '@/state/connectionStore';
import { Screen } from './Screen';
import { Banner } from './Banner';

export function AuthGate({ children }: PropsWithChildren) {
  const [hydrated, setHydrated] = useState(false);
  const status = useAuthStore(s => s.status);
  const client = useQueryClient();
  useEffect(() => {
    void Promise.resolve(useSettingsStore.persist.rehydrate()).then(() => {
      setHydrated(true);
      void renewOnForeground();
    });
  }, []);
  useEffect(() => auth.subscribe(user => {
    const previous = useAuthStore.getState().user;
    if (previous?.uid !== user?.uid) {
      client.clear();
      useConnectionStore.getState().set({
        health: null,
        check: null,
        passExpiry: null,
        status: 'disconnected'
      });
      if (previous)
        void credentials.clearPass().catch(() => {
        });
    }
    useAuthStore.getState().setUser(user ? { uid: user.uid, email: user.email, provider: user.providerData[0]?.providerId ?? 'password' } : null);
    if (user) {
      void ensureUserDoc(user.uid, user.displayName).catch(() => {
      });
      void renewOnForeground();
    }
  }), [client]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active')
        void renewOnForeground();
    });
    return () => sub.remove();
  }, []);
  if (!hydrated || status === 'loading')
    return <Screen title="WhisprPersonal">
      <Banner message="Restoring your sign-in…" />
    </Screen>;
  // Stack.Protected owns route changes, so no navigation happens before a navigator mounts.
  return children;
}
