import { conflictError } from "../errors"
import type { StorageAdapter, VercelBlobConfig } from "../types"

let blobModule: Promise<typeof import("@vercel/blob")> | null = null
function loadBlob(): Promise<typeof import("@vercel/blob")> {
  blobModule ??= import("@vercel/blob").catch(() => {
    blobModule = null
    throw new Error(
      "blob-db: the vercel-blob adapter needs @vercel/blob — install it with `npm i @vercel/blob`",
    )
  })
  return blobModule
}

export function createVercelBlobAdapter(
  config: VercelBlobConfig,
): StorageAdapter {
  return {
    async read(pathname) {
      const { get } = await loadBlob()

      const result = await get(pathname, {
        token: config.token,
        access: config.access ?? "public",
        useCache: false,
      })

      if (!result?.stream) return { text: null, etag: null }

      const text = await new Response(result.stream as ReadableStream).text()
      return { text, etag: result.blob.etag || null }
    },

    async write(pathname, body, etag) {
      const { put, BlobPreconditionFailedError } = await loadBlob()
      try {
        await put(pathname, body, {
          access: config.access ?? "public",
          token: config.token,
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 0,
          // conditional write: only succeed if nobody else wrote since we read
          ...(etag ? { ifMatch: etag } : {}),
        })
      } catch (e: unknown) {
        if (e instanceof BlobPreconditionFailedError) throw conflictError()
        throw e
      }
    },

   
    async delete(pathname) {
      const { del } = await loadBlob()
      await del(pathname, { token: config.token })
    },
  }
}
