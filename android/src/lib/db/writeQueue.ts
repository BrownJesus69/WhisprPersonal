import type { SQLiteDatabase } from 'expo-sqlite';

// Expo's transaction connection type is not exported; it exposes the SQLiteDatabase API.
export type Transaction = SQLiteDatabase;

let queue: Promise<void> = Promise.resolve();

/** Serialize writers across all database connections in this JS runtime. */
export function writeTransaction(
  db: SQLiteDatabase,
  task: (tx: Transaction) => Promise<void>,
): Promise<void> {
  const result = queue.then(() => db.withExclusiveTransactionAsync(async tx => {
    // Exclusive transactions open a fresh connection; main-connection PRAGMAs do not carry over.
    await tx.execAsync('PRAGMA busy_timeout = 5000;');
    await task(tx);
  }));
  queue = result.catch(() => {});
  return result;
}
