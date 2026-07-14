import { nowIso } from "./utils.js";

const memoryCache = new Map();

export class CacheStore {
  constructor(env = {}) {
    this.kv = env.XUANCHE_CACHE;
    this.prefix = env.CACHE_PREFIX || "xuanche";
  }

  key(value) {
    return `${this.prefix}:${value}`;
  }

  async get(key) {
    const fullKey = this.key(key);
    if (this.kv) return this.kv.get(fullKey, "json");
    const item = memoryCache.get(fullKey);
    if (!item) return undefined;
    if (item.expiresAt && Date.now() >= item.expiresAt) {
      memoryCache.delete(fullKey);
      return undefined;
    }
    return item.value;
  }

  async put(key, value, ttlSeconds = 300) {
    const fullKey = this.key(key);
    const envelope = { ...value, _cachedAt: nowIso() };
    if (this.kv) {
      await this.kv.put(fullKey, JSON.stringify(envelope), { expirationTtl: Math.max(60, ttlSeconds) });
      return envelope;
    }
    memoryCache.set(fullKey, {
      value: envelope,
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
    return envelope;
  }

  async delete(key) {
    const fullKey = this.key(key);
    if (this.kv) return this.kv.delete(fullKey);
    memoryCache.delete(fullKey);
  }
}
