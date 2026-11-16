import type { SQLiteDatabase } from 'expo-sqlite';
import { writeTransaction, type Transaction } from '@/lib/db/writeQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeDatabase(events: string[]) {
  const transactions: { execAsync: jest.Mock }[] = [];
  const db = {
    withExclusiveTransactionAsync: jest.fn(async (task: (tx: Transaction) => Promise<void>) => {
      const id = transactions.length;
      const tx = { execAsync: jest.fn(async (sql: string) => { events.push(sql); }) };
      transactions.push(tx);
      events.push(`begin ${id}`);
      try { await task(tx as unknown as Transaction); }
      finally { events.push(`end ${id}`); }
    }),
  };
  return { db: db as unknown as SQLiteDatabase, calls: db.withExclusiveTransactionAsync, transactions };
}

test('concurrent transactions run one at a time in call order across database instances', async () => {
  const events: string[] = [];
  const first = fakeDatabase(events), second = fakeDatabase(events);
  const started = deferred(), release = deferred();
  const a = writeTransaction(first.db, async () => {
    events.push('task a'); started.resolve(); await release.promise;
  });
  const b = writeTransaction(second.db, async () => { events.push('task b'); });
  const c = writeTransaction(first.db, async () => { events.push('task c'); });
  await started.promise;
  expect(first.calls).toHaveBeenCalledTimes(1);
  expect(second.calls).not.toHaveBeenCalled();
  expect(events).toEqual(['begin 0', 'PRAGMA busy_timeout = 5000;', 'task a']);
  release.resolve();
  await Promise.all([a, b, c]);
  expect(events).toEqual([
    'begin 0', 'PRAGMA busy_timeout = 5000;', 'task a', 'end 0',
    'begin 0', 'PRAGMA busy_timeout = 5000;', 'task b', 'end 0',
    'begin 1', 'PRAGMA busy_timeout = 5000;', 'task c', 'end 1',
  ]);
  for (const tx of [...first.transactions, ...second.transactions]) {
    expect(tx.execAsync).toHaveBeenCalledTimes(1);
    expect(tx.execAsync).toHaveBeenCalledWith('PRAGMA busy_timeout = 5000;');
  }
});

test('a task failure rejects only its caller and later queued tasks still run', async () => {
  const events: string[] = [], fake = fakeDatabase(events);
  const error = new Error('database is locked');
  const a = writeTransaction(fake.db, async () => { events.push('failed'); throw error; });
  const b = writeTransaction(fake.db, async () => { events.push('next'); });
  await expect(a).rejects.toBe(error);
  await expect(b).resolves.toBeUndefined();
  expect(events).toEqual([
    'begin 0', 'PRAGMA busy_timeout = 5000;', 'failed', 'end 0',
    'begin 1', 'PRAGMA busy_timeout = 5000;', 'next', 'end 1',
  ]);
});

test('a connection failure does not poison the queue', async () => {
  const events: string[] = [], fake = fakeDatabase(events);
  fake.calls.mockRejectedValueOnce(new Error('cannot open database'));
  const task = jest.fn(async () => {});
  const a = writeTransaction(fake.db, task);
  const b = writeTransaction(fake.db, task);
  await expect(a).rejects.toThrow('cannot open database');
  await expect(b).resolves.toBeUndefined();
  expect(task).toHaveBeenCalledTimes(1);
});
