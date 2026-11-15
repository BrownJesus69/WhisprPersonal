import { base64ToBytes, wavHeader, levelDbfs } from '@/lib/audio/pcm';

test('base64 padding and arbitrary byte payloads without atob', () => {
  for (let n = 0; n < 300; n++) {
    const bytes = Uint8Array.from({ length: n }, (_,i) => (i * 71 + n) % 256);
    expect(base64ToBytes(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
  }
  expect(() => base64ToBytes('!bad')).toThrow();
});
test('canonical PCM WAV header', () => {
  const h = wavHeader(32000); const v = new DataView(h.buffer);
  expect(Buffer.from(h).toString('ascii',0,4)).toBe('RIFF');
  expect(Buffer.from(h).toString('ascii',8,12)).toBe('WAVE');
  expect(v.getUint32(4,true)).toBe(32036); expect(v.getUint32(40,true)).toBe(32000);
  expect(v.getUint16(20,true)).toBe(1); expect(v.getUint16(22,true)).toBe(1);
  expect(v.getUint32(24,true)).toBe(16000); expect(v.getUint32(28,true)).toBe(32000);
  expect(v.getUint16(32,true)).toBe(2); expect(v.getUint16(34,true)).toBe(16);
});
test('RMS level: silence, full scale and half scale', () => {
  expect(levelDbfs(new Int16Array(20))).toBe(-96);
  expect(levelDbfs(new Int16Array([32767,-32768]))).toBeCloseTo(0,2);
  expect(levelDbfs(new Int16Array([16384,-16384]))).toBeCloseTo(-6.0206,3);
});
