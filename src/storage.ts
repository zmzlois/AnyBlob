import { createR2Adapter } from "./adapters/r2"
import { createS3Adapter } from "./adapters/s3"
import { createVercelBlobAdapter } from "./adapters/vercel-blob"
import type { DbConfig, StorageAdapter } from "./types"

function getPathname(tableName: string, config: DbConfig): string {
  const prefix = (config.prefix ?? "blob-db").replace(/^\/+|\/+$/g, "")
  return prefix ? `${prefix}/${tableName}.json` : `${tableName}.json`
}

const adapterCache = new WeakMap<DbConfig, StorageAdapter>()

function resolveAdapter(config: DbConfig): StorageAdapter {
  const cached = adapterCache.get(config)
  if (cached) return cached

  let adapter: StorageAdapter
  switch (config.adapter) {
    case "r2":
      adapter = createR2Adapter(config)
      break
    case "s3":
      adapter = createS3Adapter(config)
      break
    case "custom":
      adapter = config.storage
      break
    default:
      adapter = createVercelBlobAdapter(config)
  }

  adapterCache.set(config, adapter)
  return adapter
}

interface ReadResult<T> {
  data: T[]
  etag: string | null
}

export async function readTable<T>(
  tableName: string,
  config: DbConfig,
): Promise<ReadResult<T>> {
  const pathname = getPathname(tableName, config)
  const { text, etag } = await resolveAdapter(config).read(pathname)
  if (text === null) return { data: [], etag: null }
  return { data: JSON.parse(text) as T[], etag }
}

export async function writeTable<T>(
  tableName: string,
  data: T[],
  etag: string | null,
  config: DbConfig,
): Promise<void> {
  const pathname = getPathname(tableName, config)
  await resolveAdapter(config).write(pathname, JSON.stringify(data), etag)
}

// read-modify-write with optimistic locking via etag conditional writes.
// retries up to maxRetries times when a concurrent write is detected (412).
export async function withTable<T>(
  tableName: string,
  config: DbConfig,
  transform: (rows: T[]) => T[],
  maxRetries = 3,
): Promise<T[]> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, etag } = await readTable<T>(tableName, config)
    const next = transform(data)
    try {
      await writeTable(tableName, next, etag, config)
      return next
    } catch (e: unknown) {
      if (
        (e as { status?: number })?.status === 412 &&
        attempt < maxRetries - 1
      )
        continue
      throw e
    }
  }
  throw new Error(`blob-db: write conflict after ${maxRetries} retries`)
}
