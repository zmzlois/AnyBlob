// cloudflare worker using the zero-dependency r2 binding adapter.
// the bucket binding comes straight from wrangler.jsonc — no tokens, no signing.
//
// this is a pnpm workspace package that depends on vercel-blob-db via
// workspace:*, so build the library once from the repo root first:
//
//   pnpm install && pnpm build
//   pnpm --filter blob-db-r2-example exec wrangler r2 bucket create my-db
//   pnpm --filter blob-db-r2-example dev
//
// full crud surface:
//   curl -X POST localhost:8787/users -d '{"name":"Alice","email":"a@test.com","age":30}'
//   curl localhost:8787/users
//   curl localhost:8787/users?name=Alice
//   curl localhost:8787/users/<id>
//   curl -X PUT localhost:8787/users/<id> -d '{"age":31}'
//   curl -X DELETE localhost:8787/users/<id>
//   curl -X DELETE localhost:8787/users
import { WorkerEntrypoint } from "cloudflare:workers"
import type { InferRow, InsertRow, R2BucketLike } from "blob-db"
import { col, createDb, defineTable, eq } from "blob-db"

interface Env {
  DB_BUCKET: R2BucketLike
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

type UserSchema = (typeof users)["_schema"]

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })

// tiny visual test ui served at / — every button round-trips through the
// crud api below, so you can watch reads and writes hit the r2 binding.
// client js uses string concat instead of template literals on purpose,
// so nothing needs escaping inside this outer template literal.
const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>blob-db r2 visual test</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 680px; margin: 2rem auto; padding: 0 1rem; background: #0b0e14; color: #e6e6e6 }
  h1 { font-size: 1.05rem }
  form, .row { display: flex; gap: .5rem; margin: .6rem 0; flex-wrap: wrap }
  input { flex: 1; min-width: 7rem; padding: .45rem; background: #151a23; color: inherit; border: 1px solid #2a3242; border-radius: 6px }
  button { padding: .45rem .9rem; background: #1f2937; color: inherit; border: 1px solid #374151; border-radius: 6px; cursor: pointer }
  button:hover { background: #374151 }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: .85rem }
  td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #222a38 }
  pre { background: #151a23; padding: .75rem; border-radius: 6px; overflow-x: auto; font-size: .78rem; min-height: 3rem }
  .muted { color: #8b93a5; font-size: .8rem }
</style>
</head>
<body>
<h1>blob-db &times; r2 binding &mdash; visual crud test</h1>
<p class="muted">every action round-trips worker &rarr; r2 at my-app/users.json</p>
<form id="create">
  <input name="name" placeholder="name" required />
  <input name="email" placeholder="email" required />
  <input name="age" type="number" placeholder="age" required />
  <button>create</button>
</form>
<div class="row">
  <button id="refresh">refresh</button>
  <button id="wipe">wipe table</button>
</div>
<table>
  <thead><tr><th>name</th><th>email</th><th>age</th><th>active</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<pre id="log">ready.</pre>
<script>
  var logEl = document.getElementById("log")
  var log = function (label, data) {
    logEl.textContent = label + "\\n" + JSON.stringify(data, null, 2)
  }
  function call(method, path, body) {
    return fetch(path, { method: method, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().then(function (data) {
          log(method + " " + path + " -> " + res.status, data)
          return data
        })
      })
  }
  function refresh() {
    return call("GET", "/users").then(function (rows) {
      document.getElementById("rows").innerHTML = rows.map(function (u) {
        return "<tr><td>" + u.name + "</td><td>" + u.email + "</td><td>" + u.age +
          "</td><td>" + u.active + "</td><td>" +
          '<button data-act="age" data-id="' + u.id + '" data-age="' + u.age + '">age+1</button> ' +
          '<button data-act="del" data-id="' + u.id + '">delete</button></td></tr>'
      }).join("")
    })
  }
  document.getElementById("create").addEventListener("submit", function (e) {
    e.preventDefault()
    var f = new FormData(e.target)
    call("POST", "/users", {
      name: f.get("name"),
      email: f.get("email"),
      age: Number(f.get("age")),
    }).then(function () { e.target.reset(); refresh() })
  })
  document.getElementById("refresh").addEventListener("click", refresh)
  document.getElementById("wipe").addEventListener("click", function () {
    call("DELETE", "/users").then(refresh)
  })
  document.getElementById("rows").addEventListener("click", function (e) {
    var b = e.target.closest("button")
    if (!b) return
    if (b.dataset.act === "del") call("DELETE", "/users/" + b.dataset.id).then(refresh)
    if (b.dataset.act === "age")
      call("PUT", "/users/" + b.dataset.id, { age: Number(b.dataset.age) + 1 }).then(refresh)
  })
  refresh()
</script>
</body>
</html>`

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    // cheap to build per request — the r2 adapter is just the binding,
    // no client setup. prefix works exactly like the vercel-blob adapter:
    // tables land at my-app/<table>.json inside the bucket.
    const db = createDb({
      adapter: "r2",
      bucket: this.env.DB_BUCKET,
      prefix: "my-app",
    })

    const url = new URL(request.url)
    const [root, id] = url.pathname.split("/").filter(Boolean)

    // visual test page — open http://localhost:8787 in a browser
    if (!root)
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })

    if (root !== "users")
      return json(
        { usage: "GET|POST|DELETE /users, GET|PUT|DELETE /users/:id" },
        404,
      )

    try {
      switch (request.method) {
        // create — accepts a single row or an array for batch insert
        case "POST": {
          if (id) return json({ error: "post to /users, not /users/:id" }, 400)
          const body = (await request.json()) as
            | InsertRow<UserSchema>
            | InsertRow<UserSchema>[]
          const inserted = await db.insert(users).values(body).returning()
          return json(Array.isArray(body) ? inserted : inserted[0], 201)
        }

        // read — one by id, or the whole table with an optional ?name= filter
        case "GET": {
          if (id) {
            const [user] = await db.select().from(users).where(eq(users.id, id))
            return user ? json(user) : json({ error: "not found" }, 404)
          }
          const name = url.searchParams.get("name")
          const rows = name
            ? await db.select().from(users).where(eq(users.name, name))
            : await db.select().from(users)
          return json(rows)
        }

        // update — partial patch against one row
        case "PUT": {
          if (!id) return json({ error: "put needs /users/:id" }, 400)
          const patch = (await request.json()) as Partial<InferRow<UserSchema>>
          const updated = await db
            .update(users)
            .set(patch)
            .where(eq(users.id, id))
            .returning()
          return updated.length
            ? json(updated[0])
            : json({ error: "not found" }, 404)
        }

        // delete — one row by id, or wipe the whole table
        case "DELETE": {
          if (id) {
            const deleted = await db
              .delete(users)
              .where(eq(users.id, id))
              .returning()
            return deleted.length
              ? json(deleted[0])
              : json({ error: "not found" }, 404)
          }
          await db.wipe(users)
          return json({ wiped: users._name })
        }

        default:
          return new Response("Method Not Allowed", {
            status: 405,
            headers: { Allow: "GET, POST, PUT, DELETE" },
          })
      }
    } catch (e) {
      return json({ error: String(e) }, 500)
    }
  }
}
