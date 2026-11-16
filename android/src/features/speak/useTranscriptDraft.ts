import { useCallback, useEffect, useRef, useState } from 'react';
import { kv } from '@/lib/storage/kv';
import { draftKey } from './drafts';

export function useTranscriptDraft(owner: string, id: string, raw: string, polished: string) {
  const [cleaned, setCleaned] = useState(false), [text, setText] = useState(''), [error, setError] = useState(false);
  const pending = useRef<{ key: string; text: string } | null>(null), writes = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const edit = pending.current;
    if (!edit) return;
    const write = writes.current.catch(() => {}).then(() => kv.setItem(edit.key, edit.text));
    writes.current = write;
    await write;
    if (pending.current === edit) pending.current = null;
    setError(false);
  }, []);
  useEffect(() => {
    let disposed = false;
    const key = draftKey(owner, id, cleaned);
    void kv.getItem(key).then(value => { if (!disposed) setText(pending.current?.key === key ? pending.current.text : value ?? (cleaned ? polished : raw)); }).catch(() => { if (!disposed) { setText(cleaned ? polished : raw); setError(true); } });
    return () => { disposed = true; };
  }, [owner, id, cleaned, raw, polished]);
  useEffect(() => () => { void flush().catch(() => {}); }, [flush]);
  const edit = (value: string) => {
    setText(value); pending.current = { key: draftKey(owner, id, cleaned), text: value };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush().catch(() => setError(true)); }, 350);
  };
  const changeCleaned = async (value: boolean) => { await flush(); setCleaned(value); };
  return { text, edit, cleaned, changeCleaned, flush, error };
}
