import { writeFileSync } from 'node:fs';
// The real encoder behind Expo SDK 58's global fetch (expo/fetch). It is what rejected every chunk
// upload on the phone, so test the app's form against it rather than a mock.
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';

class FakeFormData {
  parts: [string, unknown][] = [];
  append(name: string, value: unknown) { this.parts.push([name, value]); }
  entries() { return this.parts; }
}
const pcm = Uint8Array.from({ length: 64 }, (_, i) => i);
// Shape of an expo-file-system File: name, type and bytes() (it implements the Blob interface).
const expoFile = { name: '000000_0_10000_0_e_' + 'a'.repeat(32) + '.wav', type: 'audio/wav', bytes: async () => pcm };

test('React Native uri parts are rejected by expo/fetch: the bug that blocked every upload', async () => {
  const form = new FakeFormData();
  form.append('file', { uri: 'file:///chunk.wav', name: 'chunk.wav', type: 'audio/wav' });
  await expect(convertFormDataAsync(form as unknown as FormData)).rejects.toThrow('Unsupported FormDataPart implementation');
});

test('the upload form (fields plus an expo File part) encodes as standard multipart', async () => {
  const form = new FakeFormData();
  for (const [k, v] of Object.entries({ chunk_id: 'a'.repeat(32), sequence: '0', start_ms: '0', end_ms: '10000', overlap_ms: '0', continues: 'false', sha256: 'b'.repeat(64) })) form.append(k, v);
  form.append('file', expoFile);
  const { body, boundary } = await convertFormDataAsync(form as unknown as FormData, 'WhisprTestBoundary');
  const text = Buffer.from(body).toString('latin1');
  expect(boundary).toBe('WhisprTestBoundary');
  expect(text).toContain(`content-disposition: form-data; name="file"; filename="${expoFile.name}"`);
  expect(text).toContain('content-type: audio/wav');
  expect(Buffer.from(body).includes(Buffer.from(pcm))).toBe(true);
  if (process.env.WHISPR_MULTIPART_OUT) writeFileSync(process.env.WHISPR_MULTIPART_OUT, body);
});
