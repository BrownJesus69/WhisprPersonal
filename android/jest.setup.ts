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
jest.mock('expo-network', () => ({ getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })) }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '0.4.0', sdkVersion: '58', extra: { features: { googleSignIn: false }, consentVersion: '2026-11-15' } } } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() }, useSegments: () => [], useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);
// All network access is denied unless a test supplies a controlled fetch implementation.
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => {
    throw new Error('Unexpected network call in test');
  });
});
