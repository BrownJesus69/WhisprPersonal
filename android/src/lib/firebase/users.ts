import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from '@react-native-firebase/firestore';

export async function ensureUserDoc(uid: string, displayName: string | null) {
  const ref = doc(getFirestore(), 'users', uid);
  if (!(await getDoc(ref)).exists())
    await setDoc(ref, { displayName: displayName ?? '', createdAt: serverTimestamp(), preferences: {} });
}
