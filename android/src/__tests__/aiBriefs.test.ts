import { doc, collection, onSnapshot, setDoc, orderBy, limit, Timestamp } from '@react-native-firebase/firestore';
import { briefDocument, BRIEF_KEYS, fromBrief, saveBrief, subscribeBriefs } from '../lib/ai/briefs';
import { MemoryRepositories } from '../lib/db/memoryRepositories';
import { draft } from './aiFixtures';

test('save emits exact contract, preserves model output, and marks saved without server acknowledgement', async () => {
  jest.mocked(setDoc).mockImplementationOnce(() => new Promise(() => {}));
  const repo = new MemoryRepositories(), d = draft({ edited_text: 'Owner reviewed text' }); await repo.putBriefDraft(d);
  expect(await saveBrief('owner',d,undefined,repo)).toBe(d.id);
  const [ref, data] = jest.mocked(setDoc).mock.calls[0];
  expect(ref).toMatchObject({ path: 'events', id: 'event-1' });
  expect(doc).toHaveBeenCalledWith(expect.anything(),'events','event-1','briefs',d.id);
  expect(Object.keys(data).sort()).toEqual([...BRIEF_KEYS].sort());
  expect(data).toMatchObject({ generatedText: 'Generated text', finalText: 'Owner reviewed text', edited: true, provider: 'groq', status: 'saved', updatedAt: { type: 'server-timestamp' } });
  expect((await repo.briefDrafts('owner','event-1'))[0].status).toBe('saved');
});
test('late rules rejection reports a sync error while the local saved copy survives', async () => {
  jest.mocked(setDoc).mockRejectedValueOnce(new Error('rules rejected'));
  const repo = new MemoryRepositories(), rejected = jest.fn(); await repo.putBriefDraft(draft());
  await saveBrief('owner',draft(),rejected,repo); await Promise.resolve(); expect(rejected).toHaveBeenCalled();
  expect((await repo.briefDrafts('owner','event-1'))[0].status).toBe('saved');
});
test('save refuses wrong owner and empty text before any write', async () => {
  await expect(saveBrief('other',draft())).rejects.toThrow();
  await expect(saveBrief('owner',draft({ edited_text: ' ' }))).rejects.toThrow(); expect(setDoc).not.toHaveBeenCalled();
});
test('brief subscription orders latest fifty and accepts cached pending writes with null updatedAt', () => {
  const next = jest.fn(), error = jest.fn(); subscribeBriefs('event-1',next,error);
  expect(collection).toHaveBeenCalledWith(expect.anything(),'events','event-1','briefs');
  expect(orderBy).toHaveBeenCalledWith('createdAt','desc'); expect(limit).toHaveBeenCalledWith(50);
  const call = jest.mocked(onSnapshot).mock.calls[0] as unknown as [unknown,unknown,(value: unknown) => void,unknown];
  const data = { ...briefDocument('owner',draft()), updatedAt: null };
  call[2]({ docs: [{ id: 'id', data: () => data },{ id: 'bad', data: () => ({}) }], metadata: { fromCache: true } });
  expect(next).toHaveBeenCalledWith([expect.objectContaining({ id: 'id', finalText: 'Generated text' })],true);
  expect(call[3]).toBe(error);
});
test.each(BRIEF_KEYS)('saved brief ignores missing %s', key => {
  const data: Record<string,unknown> = { ...briefDocument('owner',draft()), updatedAt: Timestamp.fromDate(new Date()) }; delete data[key];
  expect(fromBrief('id',data)).toBeNull();
});
