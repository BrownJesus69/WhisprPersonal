const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Native stream payloads are raw PCM, not WAV and not UTF-8. */
export function base64ToBytes(input: string): Uint8Array {
  const s = input.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))
    throw new Error('Invalid PCM base64');
  const bytes = new Uint8Array(s.length / 4 * 3 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
  let bits = 0, count = 0, out = 0;
  for (const char of s) {
    if (char === '=') break;
    bits = (bits << 6) | alphabet.indexOf(char);
    count += 6;
    if (count >= 8) { count -= 8; bytes[out++] = (bits >>> count) & 255; }
  }
  return bytes;
}

export function wavHeader(pcmBytes: number): Uint8Array {
  if (!Number.isInteger(pcmBytes) || pcmBytes < 0 || pcmBytes % 2 || pcmBytes > 0xffffffff - 36)
    throw new Error('Invalid PCM size');
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, pcmBytes + 36, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data');
  v.setUint32(40, pcmBytes, true);
  return header;
}

export function levelDbfs(samples: Int16Array): number {
  if (!samples.length) return -96;
  let sum = 0;
  for (const value of samples) sum += (value / 32768) ** 2;
  return Math.max(-96, 10 * Math.log10(sum / samples.length));
}
