import * as SecureStore from 'expo-secure-store';

export interface OfflinePass {
  grant: string;
  expiresAt: number;
  grantId: string;
  serverUrl: string;
  uid: string;
}

const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
export const credentials = {
  onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getServerKey: () => SecureStore.getItemAsync('whispr.server-key'),
  async setServerKey(key: string) { await SecureStore.setItemAsync('whispr.server-key', key); changed(); },
  async getPass(): Promise<OfflinePass | null> {
    const value = await SecureStore.getItemAsync('whispr.offline-pass');
    if (!value)
      return null;
    try {
      const pass: unknown = JSON.parse(value);
      if (!pass || typeof pass !== 'object') return null;
      const candidate = pass as Partial<OfflinePass>;
      return typeof candidate.grant === 'string' && candidate.grant.startsWith('wpg1.') &&
        typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) &&
        typeof candidate.grantId === 'string' && typeof candidate.serverUrl === 'string' &&
        typeof candidate.uid === 'string' ? candidate as OfflinePass : null;
    }
    catch {
      return null;
    }
  },
  async setPass(pass: OfflinePass) { await SecureStore.setItemAsync('whispr.offline-pass', JSON.stringify(pass)); changed(); },
  async clearPass() { await SecureStore.deleteItemAsync('whispr.offline-pass'); changed(); },
};
