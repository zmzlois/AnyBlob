import { conflictError } from "../errors"
import type { R2Config, StorageAdapter } from "../types"

// cloudflare r2 via the workers binding. r2 supports conditional writes
// natively (onlyIf.etagMatches / etagDoesNotMatch), so optimistic locking
// works the same as the vercel-blob adapter. the unquoted `etag` from get()
// round-trips directly into etagMatches — never use httpEtag here, it's quoted.
export function createR2Adapter(config: R2Config): StorageAdapter {
  return {
    async read(pathname) {
      const obj = await config.bucket.get(pathname)
      if (!obj) return { text: null, etag: null }
      return { text: await obj.text(), etag: obj.etag }
    },

    async create(pathname, body) {
      const result = await config.bucket.put(pathname, body, {
        httpMetadata: { contentType: "application/json" },
        onlyIf: { etagDoesNotMatch: "*" },
      })
      if (result === null) throw conflictError()
    },

    async update(pathname, body, etag) {
      const result = await config.bucket.put(pathname, body, {
        httpMetadata: { contentType: "application/json" },
        // conditional write: only succeed if nobody else wrote since we read
        ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
      })
      // r2 signals a failed precondition by returning null instead of throwing
      if (result === null) throw conflictError()
    },

    async delete(pathname) {
      await config.bucket.delete(pathname)
    },
  }
}
