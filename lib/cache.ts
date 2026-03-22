interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TTLCache<K, V> {
  private store = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    for (const [key, entry] of this.store) {
      if (Date.now() > entry.expiresAt) this.store.delete(key);
    }
    return this.store.size;
  }
}

// Embedding cache: text -> number[]
const EMBEDDING_TTL_MS = 60 * 60 * 1000; // 1 hour

// Solve result cache: keyed by a fingerprint of the solve request
const SOLVE_RESULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface CachedMatchResult {
  term: string;
  definition: string;
}

export const embeddingCache = new TTLCache<string, number[]>(EMBEDDING_TTL_MS);
export const solveResultCache = new TTLCache<string, unknown>(
  SOLVE_RESULT_TTL_MS,
);

export function buildCacheKey(
  parts: (string | string[] | undefined)[],
): string {
  return parts
    .map((p) => (Array.isArray(p) ? p.join("||") : (p ?? "")))
    .join("::");
}
