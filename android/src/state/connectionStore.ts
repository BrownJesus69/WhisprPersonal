import { create } from 'zustand';
import type { Health, AuthCheck } from '@/lib/server/types';

export type ConnectionStatus = 'disconnected' | 'testing' | 'reachable' | 'verifying' | 'verified' | 'connected' | 'error' | 'renew_required';
interface Connection {
  health: Health | null;
  check: AuthCheck | null;
  passExpiry: number | null;
  status: ConnectionStatus;
  scannedUrl: string | null;
  set: (value: Partial<Omit<Connection, 'set'>>) => void;
}

export const useConnectionStore = create<Connection>()(set => ({
  health: null,
  check: null,
  passExpiry: null,
  status: 'disconnected',
  scannedUrl: null,
  set: value => set(value)
}));
