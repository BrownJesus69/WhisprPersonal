jest.mock('@react-native-firebase/app', () => ({ getApp: jest.fn(() => ({})) }));
jest.mock('@react-native-firebase/auth', () => ({
  getAuth: jest.fn(() => ({ currentUser: { uid: 'test-user', email: 'test@example.test', providerData: [{ providerId: 'password' }] } })),
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  sendPasswordResetEmail: jest.fn(),
  getIdToken: jest.fn(async () => 'test-firebase-token'),
  signOut: jest.fn(async () => {
  }),
  GoogleAuthProvider: { credential: jest.fn() },
  signInWithCredential: jest.fn(),
}));
jest.mock('@react-native-firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  collection: jest.fn((_db: unknown, path: string) => ({ path })),
  // doc(collectionRef) with no path generates an id on the device, like RNFirebase.
  doc: jest.fn((parent: { path?: string }, path?: string, id?: string) =>
    path === undefined ? { path: `${parent.path}/event-1`, id: 'event-1' } : { path, id }),
  addDoc: jest.fn(async () => ({ id: 'event-1' })),
  getDoc: jest.fn(),
  setDoc: jest.fn(async () => undefined),
  updateDoc: jest.fn(async () => undefined),
  query: jest.fn((...args: unknown[]) => args),
  where: jest.fn((...args: unknown[]) => args),
  orderBy: jest.fn((...args: unknown[]) => args),
  limit: jest.fn((value: number) => value),
  onSnapshot: jest.fn(() => jest.fn()),
  serverTimestamp: jest.fn(() => ({ type: 'server-timestamp' })),
  Timestamp: class Timestamp {
    ms: number;
    constructor(ms: number) {
      this.ms = ms;
    }
    static fromDate(date: Date) {
      return new this(date.getTime());
    }
    toMillis() {
      return this.ms;
    }
    toDate() {
      return new Date(this.ms);
    }
  },
}));
jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null), setItemAsync: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }), deleteItemAsync: jest.fn(async (key: string) => {
      values.delete(key);
    })
  };
});
jest.mock('expo-sqlite/kv-store', () => {
  const values = new Map<string, string>();
  return {
    __esModule: true, default: {
      getItem: jest.fn(async (key: string) => values.get(key) ?? null), setItem: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
      }), removeItem: jest.fn(async (key: string) => {
        values.delete(key);
      })
    }
  };
});
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, jest.fn()] }));
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: { configure: jest.fn(), hasPlayServices: jest.fn(), signIn: jest.fn() } }));
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })), addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })) }));
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn(async () => { throw new Error('Use memory repositories in tests'); }) }));
jest.mock('@siteed/audio-studio', () => ({ AudioRecorderProvider: ({ children }: { children: unknown }) => children, useSharedAudioRecorder: jest.fn() }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual('node:crypto').randomUUID(),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: jest.fn(async (_algorithm: string, bytes: Uint8Array) => {
    const hash = jest.requireActual('node:crypto').createHash('sha256').update(bytes).digest();
    return Uint8Array.from(hash).buffer;
  })
}));
jest.mock('expo-file-system', () => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const uri = (parts: ({ uri: string } | string)[]) => parts.map(p => typeof p === 'string' ? p : p.uri).join('/').replace(/\/{2,}/g, '/').replace('file:/', 'file:///');
  class File {
    uri: string;
    constructor(...parts: ({ uri: string } | string)[]) { this.uri = uri(parts); }
    get name() { return this.uri.split('/').pop()!; }
    get exists() { return files.has(this.uri); }
    get size() { return files.get(this.uri)?.length ?? 0; }
    create() { files.set(this.uri, new Uint8Array()); }
    delete() { files.delete(this.uri); }
    move(to: File) { files.set(to.uri, files.get(this.uri)!); files.delete(this.uri); this.uri = to.uri; }
    async bytes() { return files.get(this.uri)!.slice(); }
    open() {
      if (!this.exists) throw new Error('Missing file');
      const file = this;
      return { offset: 0, get size() { return file.size; }, close: jest.fn(),
        readBytes: jest.fn(async function (this: { offset: number }, n: number) {
          const result = files.get(file.uri)!.slice(this.offset, this.offset + n); this.offset += result.length; return result;
        }),
        writeBytes: async function (this: { offset: number }, bytes: Uint8Array) {
          const old = files.get(file.uri)!;
          const next = new Uint8Array(Math.max(old.length, this.offset + bytes.length)); next.set(old); next.set(bytes, this.offset); this.offset += bytes.length; files.set(file.uri, next);
        }
      };
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: ({ uri: string } | string)[]) { this.uri = uri(parts); }
    get exists() { return dirs.has(this.uri); }
    create() { dirs.add(this.uri); }
    list() { return [...files.keys()].filter(p => p.startsWith(this.uri + '/') && !p.slice(this.uri.length + 1).includes('/')).map(p => new File(p)); }
  }
  return { File, Directory, Paths: { document: { uri: 'file:///documents' }, availableDiskSpace: 10 * 1024 ** 3 } };
});
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '0.5.0', sdkVersion: '58', extra: { features: { googleSignIn: false }, consentVersion: '2026-11-15' } } } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() }, useSegments: () => [], useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);
// All network access is denied unless a test supplies a controlled fetch implementation.
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => {
    throw new Error('Unexpected network call in test');
  });
});
