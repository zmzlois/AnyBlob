import type { AwsClient } from "aws4fetch"
import { conflictError } from "../errors"
import type { S3Config, StorageAdapter } from "../types"

function resolveEndpoint(config: S3Config): string {
  if (config.endpoint) return config.endpoint.replace(/\/+$/, "")
  if (config.accountId)
    return `https://${config.accountId}.r2.cloudflarestorage.com`
  throw new Error(
    "blob-db: s3 adapter needs `endpoint`, or `accountId` for cloudflare r2",
  )
}

// keys contain slashes that must survive as path separators
function encodeKey(pathname: string): string {
  return pathname.split("/").map(encodeURIComponent).join("/")
}

export function createS3Adapter(config: S3Config): StorageAdapter {
  const baseUrl = `${resolveEndpoint(config)}/${config.bucket}`

  // lazy so aws4fetch stays an optional peer — only loaded when this adapter is used
  let clientPromise: Promise<AwsClient> | null = null
  function loadClient(): Promise<AwsClient> {
    clientPromise ??= import("aws4fetch").then(
      (m) =>
        new m.AwsClient({
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          service: "s3",
          region: config.region ?? "auto",
        }),
      () => {
        clientPromise = null
        throw new Error(
          "blob-db: the s3 adapter needs aws4fetch — install it with `npm i aws4fetch`",
        )
      },
    )
    return clientPromise
  }

  return {
    async read(pathname) {
      const client = await loadClient()
      const res = await client.fetch(`${baseUrl}/${encodeKey(pathname)}`)
      if (res.status === 404) {
        await res.body?.cancel()
        return { text: null, etag: null }
      }
      if (!res.ok)
        throw new Error(`blob-db: s3 read failed with status ${res.status}`)
      return { text: await res.text(), etag: res.headers.get("etag") }
    },

    async create(pathname, body) {
      const client = await loadClient()
      const res = await client.fetch(`${baseUrl}/${encodeKey(pathname)}`, {
        method: "PUT",
        body,
        headers: {
          "content-type": "application/json",
          "if-none-match": "*",
        },
      })
      await res.body?.cancel()
      if (res.status === 412) throw conflictError()
      if (!res.ok)
        throw new Error(`blob-db: s3 create failed with status ${res.status}`)
    },

    async update(pathname, body, etag) {
      const client = await loadClient()
      const res = await client.fetch(`${baseUrl}/${encodeKey(pathname)}`, {
        method: "PUT",
        body,
        headers: {
          "content-type": "application/json",
          // conditional write: only succeed if nobody else wrote since we read
          ...(etag ? { "if-match": etag } : {}),
        },
      })
      await res.body?.cancel()
      if (res.status === 412) throw conflictError()
      if (!res.ok)
        throw new Error(`blob-db: s3 update failed with status ${res.status}`)
    },

    async delete(pathname) {
      const client = await loadClient()
      const res = await client.fetch(`${baseUrl}/${encodeKey(pathname)}`, {
        method: "DELETE",
      })
      await res.body?.cancel()
      if (!res.ok && res.status !== 404)
        throw new Error(`blob-db: s3 delete failed with status ${res.status}`)
    },
  }
}
