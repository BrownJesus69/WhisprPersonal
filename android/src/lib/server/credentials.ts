import * as SecureStore from 'expo-secure-store';

export interface OfflinePass {
  grant: string;
  expiresAt: number;
  grantId: string;
  serverUrl: string;
  uid: string;
}

export const credentials = {
  getServerKey: () => SecureStore.getItemAsync('whispr.server-key'),
  setServerKey: (key: string) => SecureStore.setItemAsync('whispr.server-key', key),
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
  setPass: (pass: OfflinePass) => SecureStore.setItemAsync('whispr.offline-pass', JSON.stringify(pass)),
  clearPass: () => SecureStore.deleteItemAsync('whispr.offline-pass'),
};
