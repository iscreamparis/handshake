// In-process keyed mutex: operations on the same key run one after the other (one Handshake instance).
// Cross-process safety does not rely on it: every fact is also guarded by a unique key in the database.

export type KeyedLock = <R>(keys: string[], fn: () => Promise<R>) => Promise<R>

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<unknown>>()
  return async function locked<R>(keys: string[], fn: () => Promise<R>): Promise<R> {
    const sorted = [...new Set(keys)].sort()
    const run = async (i: number): Promise<R> => {
      if (i === sorted.length) return fn()
      const key = sorted[i]!
      const prev = tails.get(key) ?? Promise.resolve()
      const mine = prev.then(() => run(i + 1), () => run(i + 1))
      const tail = mine.catch(() => undefined)
      tails.set(key, tail)
      try { return await mine } finally { if (tails.get(key) === tail) tails.delete(key) }
    }
    return run(0)
  }
}
