import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { shareDocument } from '../lib/export/share';
const doc = { filename: 'whisprpersonal-test.txt', mimeType: 'text/plain', content: 'Hello \u0c95\u0ca8\u0ccd\u0ca8\u0ca1' };
test('writes UTF8 and shares cache file with MIME type', async () => {
  const write = jest.spyOn(File.prototype,'write');
  await shareDocument(doc);
  expect(write).toHaveBeenCalledWith(doc.content);
  expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/exports/whisprpersonal-test.txt',expect.objectContaining({ mimeType: 'text/plain' })); write.mockRestore();
});
test('cleans only files older than 24h', async () => {
  const old = new File(Paths.cache,'exports','old.txt'), fresh = new File(Paths.cache,'exports','fresh.txt');
  old.create(); fresh.create();
  Object.defineProperty(old,'modificationTime',{ value: Date.now()-25*3600000 });
  const listing = jest.spyOn(Directory.prototype,'list').mockReturnValue([old,fresh]);
  await shareDocument(doc); expect(old.exists).toBe(false); expect(fresh.exists).toBe(true); listing.mockRestore();
});
test('unavailable sharing returns clear error and does not share', async () => {
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValueOnce(false);
  await expect(shareDocument(doc)).rejects.toThrow('Sharing is not available'); expect(Sharing.shareAsync).not.toHaveBeenCalled();
});
test('refuses path traversal', async () => { await expect(shareDocument({ ...doc,filename: '../bad' })).rejects.toThrow('Invalid export filename'); });
