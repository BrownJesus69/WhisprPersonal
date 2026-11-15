import { create } from 'zustand';

export interface AppUser {
  uid: string;
  email: string | null;
  provider: string;
}

export const useAuthStore = create<{
  user: AppUser | null;
  status: 'loading' | 'signed_in' | 'signed_out';
  setUser: (user: AppUser | null) => void;
}>()(set => ({ user: null, status: 'loading', setUser: user => set({ user, status: user ? 'signed_in' : 'signed_out' }) }));
