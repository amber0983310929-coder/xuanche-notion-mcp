import test from "node:test";
import assert from "node:assert/strict";
import { CacheStore } from "../src/cache.js";

test("memory cache deletes every matching world key", async () => {
  const cache = new CacheStore({ CACHE_PREFIX: "cache-test-memory" });
  await cache.put("world:base:a", { value: 1 });
  await cache.put("world:continue:b", { value: 2 });
  await cache.put("other:c", { value: 3 });

  assert.equal(await cache.deletePrefix("world:"), 2);
  assert.equal(await cache.get("world:base:a"), undefined);
  assert.equal(await cache.get("world:continue:b"), undefined);
  assert.equal((await cache.get("other:c")).value, 3);
});

test("KV cache deletes matching keys across list pages", async () => {
  const deleted = [];
  const kv = {
    async list({ cursor }) {
      if (!cursor) {
        return {
          keys: [{ name: "xuanche:world:a" }],
          list_complete: false,
          cursor: "next",
        };
      }
      return {
        keys: [{ name: "xuanche:world:b" }],
        list_complete: true,
      };
    },
    async delete(key) {
      deleted.push(key);
    },
  };
  const cache = new CacheStore({ XUANCHE_CACHE: kv });

  assert.equal(await cache.deletePrefix("world:"), 2);
  assert.deepEqual(deleted, ["xuanche:world:a", "xuanche:world:b"]);
});
