export type ColType =
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "timestamp"
  | "json"

export type InferColType<T extends ColType> = T extends "text"
  ? string
  : T extends "integer" | "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "timestamp"
        ? Date
        : unknown

export class ColumnDef<T extends ColType> {
  readonly _name: string
  readonly _type: T
  _isPrimary = false
  _defaultVal?: InferColType<T> | (() => InferColType<T>)
  // thunk avoids circular reference errors when two tables reference each other
  _references?: () => ColumnDef<ColType>

  constructor(name: string, type: T) {
    this._name = name
    this._type = type
  }

  primaryKey(): this {
    this._isPrimary = true
    return this
  }

  default(val: InferColType<T> | (() => InferColType<T>)): this {
    this._defaultVal = val
    return this
  }

  // T2 extends T ensures the referenced column's type is compatible
  references<T2 extends T>(ref: () => ColumnDef<T2>): this {
    this._references = ref as () => ColumnDef<ColType>
    return this
  }
}

export type TableSchema = Record<string, ColumnDef<ColType>>

export type InferRow<S extends TableSchema> = {
  [K in keyof S]: S[K] extends ColumnDef<infer T> ? InferColType<T> : never
}

type HasDefault<C> =
  C extends ColumnDef<ColType>
    ? C["_defaultVal"] extends undefined
      ? false
      : true
    : false
export type InsertRow<S extends TableSchema> = {
  [K in keyof S as HasDefault<S[K]> extends true ? never : K]: InferRow<S>[K]
} & {
  [K in keyof S as HasDefault<S[K]> extends true ? K : never]?: InferRow<S>[K]
}

export type TableDef<S extends TableSchema> = {
  _name: string
  _schema: S
} & { [K in keyof S]: S[K] }

// the two calls every backend must answer: read a table blob (with its etag)
// and conditionally write it back. write throws an error with status 412 when
// the etag no longer matches, which withTable uses to retry.
export interface StorageAdapter {
  read(pathname: string): Promise<{ text: string | null; etag: string | null }>
  write(pathname: string, body: string, etag: string | null): Promise<void>
}

// minimal structural types for cloudflare's r2 bucket binding so we don't
// force @cloudflare/workers-types on every consumer. the real R2Bucket from
// a worker's env satisfies these shapes. covers the full crud surface used
// by a typical worker: get (read), put (create/update), delete (delete).

// http metadata r2 stores on each object. set on put, read back on get.
export interface R2HTTPMetadata {
  contentType?: string
  contentLanguage?: string
  contentDisposition?: string
  contentEncoding?: string
  cacheControl?: string
  cacheExpiry?: Date
}

// user-defined metadata, stored as string key/value pairs.
export type R2CustomMetadata = Record<string, string>

// conditional headers for get/put — either a Headers object (straight off a
// request) or the structured form. mirrors how the r2 binding accepts both.
export interface R2Conditions {
  etagMatches?: string
  etagDoesNotMatch?: string
  uploadedAfter?: Date
  uploadedBefore?: Date
}

// byte range for partial reads.
export interface R2Range {
  offset?: number
  length?: number
  suffix?: number
}

// object metadata returned by both get and put. the unquoted `etag` is what
// round-trips into etagMatches; `httpEtag` is quoted and safe for response
// headers. `writeHttpMetadata` pours stored http metadata into a Headers.
export interface R2Object {
  etag: string
  httpEtag: string
  size: number
  uploaded: Date
  httpMetadata?: R2HTTPMetadata
  customMetadata?: R2CustomMetadata
  writeHttpMetadata(headers: Headers): void
}

// object returned by get — same as R2Object plus the body. `body` is a
// ReadableStream; `text()`/`arrayBuffer()`/`json()` consume it once.
export interface R2ObjectBody extends R2Object {
  body: ReadableStream
  bodyUsed: boolean
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
}

// anything r2's put accepts as a value — streams, buffers, blobs, or null.
export type R2Value =
  | ReadableStream
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | null

export interface R2BucketLike {
  // read — returns null when the key doesn't exist (or when a precondition
  // in onlyIf fails, in which case `body` is absent on the r2 side).
  get(
    key: string,
    options?: {
      onlyIf?: Headers | R2Conditions
      range?: Headers | R2Range
    },
  ): Promise<R2ObjectBody | null>

  // create/update — returns null when an onlyIf precondition fails, which
  // the r2 adapter treats as a 412 conflict for optimistic locking.
  put(
    key: string,
    value: R2Value,
    options?: {
      onlyIf?: Headers | R2Conditions
      httpMetadata?: Headers | R2HTTPMetadata
      customMetadata?: R2CustomMetadata
    },
  ): Promise<R2Object | null>

  // delete — one key or a batch of keys. resolves once removed.
  delete(key: string | string[]): Promise<void>
}

interface BaseDbConfig {
  prefix?: string
  maxRetries?: number
}

// default adapter — omitting `adapter` keeps existing createDb({ token }) code working
export interface VercelBlobConfig extends BaseDbConfig {
  adapter?: "vercel-blob"
  token: string
  access?: "public" | "private"
}

// cloudflare r2 via the workers binding — zero extra dependencies,
// only usable inside workers/pages where env.MY_BUCKET exists
export interface R2Config extends BaseDbConfig {
  adapter: "r2"
  bucket: R2BucketLike
}

// any s3-compatible store over http (cloudflare r2, aws s3, minio, ...).
// for r2, pass accountId and the endpoint is derived; otherwise pass endpoint.
// requires the optional aws4fetch peer dependency for request signing.
export interface S3Config extends BaseDbConfig {
  adapter: "s3"
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  accountId?: string
  endpoint?: string
  region?: string
}

// escape hatch — bring your own storage backend
export interface CustomStorageConfig extends BaseDbConfig {
  adapter: "custom"
  storage: StorageAdapter
}

export type DbConfig =
  | VercelBlobConfig
  | R2Config
  | S3Config
  | CustomStorageConfig

export interface Condition {
  type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "in" | "and" | "or"
  col?: string
  colRight?: string // set when rhs is a column ref (join ON clauses)
  val?: unknown
  conditions?: Condition[]
}

// injectable so the transaction can swap in its snapshot-capturing version
export type WithTableFn = <T>(
  tableName: string,
  transform: (rows: T[]) => T[],
) => Promise<T[]>
