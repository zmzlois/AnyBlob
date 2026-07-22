// cloudflare r2 over the s3-compatible http api — runnable from plain node,
// no workers runtime needed. requires the aws4fetch peer dep (`npm i aws4fetch`).
//
// inside a worker you'd use the zero-dependency binding adapter instead:
//   createDb({ adapter: "r2", bucket: env.MY_BUCKET, prefix: "my-app" })
// the prefix behaves identically in both — it's applied before the adapter
// ever sees the key, so folders work the same as the vercel-blob example.
import { and, col, createDb, defineTable, eq, gt } from "../src/index"

const accountId = process.env.R2_ACCOUNT_ID
const accessKeyId = process.env.R2_ACCESS_KEY_ID
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
const bucket = process.env.R2_BUCKET
if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
  console.error(
    "set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET before running",
  )
  process.exit(1)
}

const users = defineTable("users", {
  id: col
    .text("id")
    .primaryKey()
    .default(() => crypto.randomUUID()),
  name: col.text("name"),
  email: col.text("email"),
  age: col.integer("age"),
  active: col.boolean("active").default(true),
})

// past the guard these are narrowed to plain strings — shared by both dbs
const credentials = { accountId, bucket, accessKeyId, secretAccessKey }

// nested folder prefix — tables land at blob-db-test/r2/<table>.json
const db = createDb({
  adapter: "s3",
  ...credentials,
  prefix: "blob-db-test/r2",
})

const pass = (msg: string) => console.log("  ✓", msg)
const fail = (msg: string) => {
  console.error("  ✗", msg)
  process.exitCode = 1
}
const assert = (ok: boolean, msg: string) => (ok ? pass(msg) : fail(msg))
const print = (label: string, data: unknown) =>
  console.log(
    `  [${label}]`,
    JSON.stringify(data, null, 2).replace(/\n/g, "\n  "),
  )

async function testCrud() {
  console.log("\ncrud")
  await db.wipe(users)

  await db
    .insert(users)
    .values({ id: "1", name: "Alice", email: "alice@test.com", age: 30 })
  pass("insert")

  const [bob] = await db
    .insert(users)
    .values({ name: "Bob", email: "bob@test.com", age: 25 })
    .returning()
  print("inserted bob", bob)
  assert(bob.name === "Bob", "insert returning — name")
  assert(
    typeof bob.id === "string" && bob.id.length > 0,
    "insert returning — uuid default",
  )
  assert(bob.active === true, "insert returning — boolean default")

  const all = await db.select().from(users)
  print("select all users", all)
  assert(all.length === 2, "select all")

  const grownups = await db
    .select()
    .from(users)
    .where(and(gt(users.age, 26), eq(users.active, true)))
  assert(
    grownups.length === 1 && grownups[0].name === "Alice",
    "select compound where",
  )

  const updated = await db
    .update(users)
    .set({ age: 31 })
    .where(eq(users.name, "Alice"))
    .returning()
  assert(updated.length === 1 && updated[0].age === 31, "update returning")

  const deleted = await db
    .delete(users)
    .where(eq(users.name, "Bob"))
    .returning()
  assert(deleted.length === 1 && deleted[0].name === "Bob", "delete returning")
}

async function testFolderIsolation() {
  console.log(
    "\nfolder isolation (same table name, different prefix — must not collide)",
  )

  // same bucket, sibling folder. also passes a trailing slash on purpose —
  // it must normalize to the same folder instead of a double-slash key.
  const dbOther = createDb({
    adapter: "s3",
    ...credentials,
    prefix: "blob-db-test/r2-other/",
  })

  await db.wipe(users)
  await dbOther.wipe(users)

  await db.insert(users).values({ name: "Main", email: "m@test.com", age: 1 })
  await dbOther.insert(users).values([
    { name: "Other A", email: "a@test.com", age: 2 },
    { name: "Other B", email: "b@test.com", age: 3 },
  ])

  const mainRows = await db.select().from(users)
  const otherRows = await dbOther.select().from(users)
  print("blob-db-test/r2/users.json", mainRows)
  print("blob-db-test/r2-other/users.json", otherRows)
  assert(
    mainRows.length === 1 && mainRows[0].name === "Main",
    "main folder untouched",
  )
  assert(otherRows.length === 2, "other folder isolated")

  await dbOther.wipe(users)
}

async function testIfMatch() {
  console.log(
    "\nif-match (two concurrent writes — r2 honors conditional puts with a 412)",
  )
  await db.wipe(users)

  await db
    .insert(users)
    .values({ name: "Concurrent", email: "c@test.com", age: 1 })

  let conflictDetected = false
  const results = await Promise.allSettled([
    db.update(users).set({ age: 2 }).where(eq(users.name, "Concurrent")),
    db.update(users).set({ age: 3 }).where(eq(users.name, "Concurrent")),
  ])

  for (const r of results) {
    if (r.status === "rejected") {
      const msg = String(r.reason)
      if (msg.includes("412") || msg.includes("conflict")) {
        conflictDetected = true
        pass("if-match honored — 412 on concurrent write")
      } else {
        fail(`unexpected error: ${msg}`)
      }
    }
  }

  if (!conflictDetected)
    console.log(
      "  ⚠  no 412 — both writes landed sequentially (retries may have absorbed the conflict)",
    )

  const final = await db
    .select()
    .from(users)
    .where(eq(users.name, "Concurrent"))
  assert(final.length === 1, "row still exists")
  assert([2, 3].includes(final[0].age as number), `age is ${final[0].age}`)
}

async function main() {
  try {
    await testCrud()
    await testFolderIsolation()
    await testIfMatch()
    await db.wipe(users)
    console.log("\ndone.\n")
  } catch (e) {
    console.error("\nunhandled error:", e)
    process.exit(1)
  }
}

main()
