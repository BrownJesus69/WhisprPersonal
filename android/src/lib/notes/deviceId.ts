import { randomUUID } from 'expo-crypto';
import { kv } from '@/lib/storage/kv';

let opening: Promise<string> | undefined;
export function deviceId(): Promise<string> {
  return opening ??= (async () => {
    const existing = await kv.getItem('notes.deviceId');
    if (existing && existing.length >= 8 && existing.length <= 64) return existing;
    const id = randomUUID();
    await kv.setItem('notes.deviceId', id);
    return id;
  })().catch(error => { opening = undefined; throw error; });
}
