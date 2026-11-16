/** Bound UI waits; the underlying service may still finish and persist its result. */
export async function withDeadline<T>(work: Promise<T>, ms = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
