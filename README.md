# vercel-blob-db

[![npm version](https://img.shields.io/npm/v/vercel-blob-db)](https://www.npmjs.com/package/vercel-blob-db)
[![npm downloads](https://img.shields.io/npm/dm/vercel-blob-db)](https://www.npmjs.com/package/vercel-blob-db)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![peer: @vercel/blob](https://img.shields.io/badge/peer-%40vercel%2Fblob%20v2%2B-black)](https://vercel.com/docs/storage/vercel-blob)

A lightweight database on top of [Vercel Blob](https://vercel.com/docs/storage/vercel-blob), with a [drizzle](https://orm.drizzle.team/)-inspired query API. No SQL, no migrations, no extra infrastructure — just your blob store.

> **Not a replacement for** Postgres, PlanetScale, or any real database — every query reads and writes a JSON file.

---

## install

```bash
npm install vercel-blob-db @vercel/blob
```

## setup

```ts
import { createDb } from "vercel-blob-db"

const db = createDb({
  token: process.env.BLOB_READ_WRITE_TOKEN!, // from your Vercel project
  prefix: "my-app",                           // optional — namespaces blob keys
  access: "private",                          // "public" | "private" (default: "public")
  maxRetries: 3,                              // retries on write conflicts (default: 3)
})
```

---

## define your schema

```ts
import { defineTable, col } from "vercel-blob-db"

const users = defineTable("users", {
  id:     col.text("id").primaryKey().default(() => crypto.randomUUID()),
  name:   col.text("name"),
  email:  col.text("email"),
  age:    col.integer("age"),
  active: col.boolean("active").default(true),
})

const posts = defineTable("posts", {
  id:       col.text("id").primaryKey().default(() => crypto.randomUUID()),
  authorId: col.text("authorId").references(() => users.id), // FK → users.id
  title:    col.text("title"),
  published: col.boolean("published").default(false),
})
```

**column types:** `text` · `integer` · `number` · `boolean` · `timestamp` · `json`

**column modifiers:**
- `.primaryKey()` — marks the primary key (used for upsert conflict detection)
- `.default(val | () => val)` — static or computed default applied on insert
- `.references(() => otherTable.col)` — declares a FK; enables auto-join without an explicit `ON` clause

---

## crud

### insert

```ts
// single row — defaults applied automatically
const [user] = await db.insert(users)
  .values({ name: "Alice", email: "alice@example.com", age: 30 })
  .returning()

// batch insert
await db.insert(users).values([
  { name: "Bob",   email: "bob@example.com",   age: 25 },
  { name: "Carol", email: "carol@example.com", age: 35 },
])
```

### select

```ts
import { eq, and, gt } from "vercel-blob-db"

// all rows
const all = await db.select().from(users)

// filtered
const adults = await db.select().from(users).where(gt(users.age, 18))

// compound condition
const active_adults = await db.select().from(users)
  .where(and(gt(users.age, 18), eq(users.active, true)))
```

### update

```ts
const [updated] = await db.update(users)
  .set({ age: 31 })
  .where(eq(users.name, "Alice"))
  .returning()
```

### delete

```ts
await db.delete(users).where(eq(users.name, "Alice"))

// with returning
const [removed] = await db.delete(users)
  .where(eq(users.id, "some-id"))
  .returning()
```

---

## operators

| operator | usage |
|---|---|
| `eq(col, val)` | `col = val` |
| `ne(col, val)` | `col != val` |
| `gt(col, val)` | `col > val` |
| `gte(col, val)` | `col >= val` |
| `lt(col, val)` | `col < val` |
| `lte(col, val)` | `col <= val` |
| `like(col, pattern)` | substring match (case-insensitive) |
| `inArray(col, [vals])` | `col IN (...)` |
| `and(...conditions)` | logical AND |
| `or(...conditions)` | logical OR |

---

## joins

Foreign keys declared with `.references()` let you omit the `ON` clause — the join condition is inferred automatically.

```ts
// explicit ON (always works)
const rows = await db.select().from(posts)
  .innerJoin(users, eq(posts.authorId, users.id))

// auto ON — inferred from posts.authorId.references(() => users.id)
const rows = await db.select().from(posts).innerJoin(users)

// left join — keeps posts with no matching user (fields are undefined)
const rows = await db.select().from(posts).leftJoin(users)

// 3-table chain — FK chain is resolved automatically
const rows = await db.select().from(comments)
  .innerJoin(posts)  // comments.postId → posts.id
  .innerJoin(users)  // posts.authorId  → users.id
  .where(eq(users.name, "Alice"))
```

Joined rows are flat objects — all columns from all tables are merged together.

---

## upsert

```ts
await db.insert(users)
  .values({ id: "u-1", name: "Alice", email: "a@example.com", age: 30 })
  .onConflict(users.id, { set: { name: "Alice Updated", age: 31 } })
```

If a row with the same primary key already exists, the columns in `set` are updated instead of inserting a duplicate.

---

## transactions

Mutations inside a transaction are buffered and committed together. If an error is thrown, all touched tables are restored to their pre-transaction state.

```ts
const userId = await db.transaction(async (tx) => {
  const [user] = await tx.insert(users)
    .values({ name: "Alice", email: "a@example.com", age: 30 })
    .returning()

  await tx.insert(posts)
    .values({ authorId: user.id, title: "First post" })

  return user.id
})
```

> **Note:** this is not ACID — concurrent readers may observe partial state during execution. On failure, all mutations are rolled back.

---

## wipe

Clears all rows from one or more tables in parallel. Useful in tests.

```ts
await db.wipe(users, posts, comments)
```

---

## type inference

```ts
import type { InferRow, InsertRow } from "vercel-blob-db"

type User = InferRow<typeof users._schema>
// { id: string; name: string; email: string; age: number; active: boolean }

type NewUser = InsertRow<typeof users._schema>
// { name: string; email: string; age: number; id?: string; active?: boolean }
// — columns with defaults become optional
```

---

## how it works

Each table is stored as a single JSON blob at `<prefix>/<table-name>.json`. Reads fetch the file, parse it, filter/transform in memory, and writes upload the updated JSON back. Concurrent writes use `If-Match` / ETag headers to detect conflicts and retry automatically.

This means every query is an HTTP round-trip to Vercel Blob. Keep tables small (hundreds to low thousands of rows) and avoid high-frequency concurrent writes.

---

## license

MIT
