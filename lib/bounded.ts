/** Resolve with `fallback` if `p` rejects or takes longer than `ms`. Always clears its timer. */
export async function bounded<T, F = null>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<F>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
