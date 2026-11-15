import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ExportDocument } from './compose';
export async function shareDocument(doc: ExportDocument, now = Date.now()) {
  const directory = new Directory(Paths.cache,'exports');
  directory.create({ intermediates: true, idempotent: true });
  for (const entry of directory.list()) {
    if (entry instanceof File && entry.modificationTime !== null && entry.modificationTime < now - 24 * 3600000) entry.delete();
  }
  if (!await Sharing.isAvailableAsync()) throw new Error('Sharing is not available on this phone. Enable a sharing app and try again.');
  if (!/^[a-zA-Z0-9_.-]+$/.test(doc.filename)) throw new Error('Invalid export filename');
  const file = new File(directory,doc.filename);
  await file.write(doc.content);
  await Sharing.shareAsync(file.uri,{ mimeType: doc.mimeType, dialogTitle: 'Share WhisprPersonal export' });
}
