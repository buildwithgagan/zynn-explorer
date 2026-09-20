# Zynn Explorer

Part of the Zynn ecosystem. Connect to any Postgres database, see everything in it, and query it in
plain English. Natural-language querying is built entirely on [TypeSafe's Jev](https://docs.typesafe.ai) model.

## Design system

Explorer shares the Zynn Console's look: the same tokens, type and mark.

- **Tokens** in `public/styles.css` are copied from the Console's `app/theme.css` (dark by default,
  `html.light` for light). Pages use only those custom properties, never colour literals.
- **Type**: Mona Sans for interface text, Commit Mono for data, identifiers and metadata. Both are vendored
  in `public/fonts/` under the SIL OFL 1.1 (licence files alongside).
- **Mark**: `public/icon.svg` and the sidebar lockup use the Console's path data unchanged.
- **Appearance** follows the Console's rule and storage key (`zynn.theme`), applied before first paint.
- **Layout**: 240px sidebar (lockup, theme toggle, search, grouped navigation, object tree) beside a
  rounded, bordered main frame with a breadcrumb header.

When the Console's tokens change, copy the new values into the two blocks at the top of `styles.css`.

## Run it

```bash
npm install
npm start          # → http://localhost:4477
```

`.env` (git-ignored):

```
TYPESAFE_API_KEY=…            # required for the Ask tab
DATABASE_URL=postgres://…     # optional: connect automatically on start
DATABASE_SSL=true             # optional
```

The first screen is the connection form: host, port, database, user, password and SSL, or a single
connection URL. On success the Explorer opens; "Disconnect" returns to the form. Recent connections are
remembered in the browser **without their passwords**. Unless you save a connection, credentials live
only in the local server's memory; the server listens on `127.0.0.1` only and refuses cross-origin requests.

**Saved connections.** Tick "Save this connection on this machine" to store a connection, password
included, in `connections.local.json` (git-ignored, mode 600). Saved connections are listed at the top of
the entry screen and connect with one click. The server resolves them by name, so a saved password is
never sent to the browser. An entry with `"askPassword": true` and no password is filled into the form
and saved once you supply the password. ✕ forgets a connection. `PGX_CONNECTIONS` overrides the file path.

Once connected, **Databases → Open** switches to any other database on the same server with the
credentials already in memory. The layout is responsive: below 820px the object tree becomes a
slide-in drawer (☰) and tables scroll inside their own frame.

### Test databases in Docker

```bash
docker run -d --name pgx-test -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:5440:5432 postgres:16-alpine
for db in shop:seed.sql hr:seed-hr.sql saas:seed-saas.sql; do
  docker exec pgx-test createdb -U postgres ${db%%:*}
  docker exec -i pgx-test psql -U postgres -q -d ${db%%:*} < scripts/${db##*:}
done
```

Connect with host `localhost`, port `5440`, user `postgres`, no password. `shop` is e-commerce, `hr` is
people/salaries/leave, `saas` spans two schemas with UUID keys, JSONB and a materialized view.
Remove it with `docker rm -f pgx-test`.

## What it shows

| Area | Contents |
| --- | --- |
| Sidebar | Schemas → tables, views, materialized views, foreign tables, functions; row estimates; search across tables, columns and functions |
| Overview | Size, object counts, connections, cache hit ratio, largest relations, extensions, database stats |
| Relation | **Data** (paginated, sortable, filterable, CSV) · **Columns** (types, defaults, FKs, null/distinct stats, comments) · **Indexes & constraints** (usage, referenced-by, triggers, partitions) · **DDL** · **Access** (grants, RLS policies) · **Statistics** (scans, tuples, vacuum/analyze) |
| Relationships | Foreign-key diagram and list |
| SQL | Editor with run-selection, EXPLAIN / EXPLAIN ANALYZE, history, error positions. Read-only transaction unless "Allow writes" is ticked |
| Server | Activity and locks (auto-refresh), roles, settings (filter, changed-only), databases, sequences, types and enums |
| Ask | Natural-language querying (below) |
| Create | Natural-language schema design: draft, preview, apply (below) |

## Ask: the assistant

Ask is a chat. The thread scrolls; the composer is docked at the bottom with a send arrow (Enter sends,
Shift+Enter adds a line), and suggested questions sit just above it. One thread is kept per database while
the page is open; "New chat" clears it.

- **Suggestions are built from the connected schema** (`server/nl/assistant.js`), not a fixed list:
  the largest real tables, their label-like columns ("orders per status"), numeric measures ("total amount
  by status"), time columns ("number of orders per month this year", "latest 10 reviews"), optional dates
  ("orders with no shipped at") and places ("customers in Brazil"). Migration and other plumbing tables,
  id-like numbers and free-text columns are left out. A suggestion disappears once asked.
- **Answers are composed in code.** Jev returns judgments, not prose, so the sentence comes from the plan
  and the result: a large figure with a caption for a count or total, a one-line summary above the table
  for lists and breakdowns, and a plain statement when nothing matches.
- **Three kinds of question.** A routing judgment decides whether the question is about the *data*,
  about the *database* ("what's in the db", "list the tables"), or about one table's *structure*
  ("what columns does orders have"). The last two are answered from the catalog with no query, and link
  into the explorer. Anything unrelated is declined.
- **Conversations are saved.** Each database's thread is stored in the browser (`localStorage`, up to 40
  turns, 100 result rows per answer), so it survives page changes, reloads and reconnecting, and a
  follow-up after a reload still builds on the restored answer. "New chat" clears it.
- **It asks instead of guessing.** When the routing judgment is a near-tie between tables ("runs" could
  be `goal_runs` or `traces`), the assistant shows the candidates with row counts and columns and waits
  for a pick. When a word that names a required value ("shipped") cannot be tied to any column, the
  answer says so instead of silently dropping it, and confidence is marked low.
- **Percentages.** "What percent of orders were cancelled", "what share of those were delivered": the
  conditions in the question are the numerator, and any time period plus everything carried over from
  the previous answer define the whole. Shown as a figure with "1,012 of 3,244 …" underneath.
- **Follow-ups remember context.** Jev keeps no conversation state, so the context is the previous
  question plus its structured plan (`server/nl/followup.js`). A judgment in the routing request decides
  whether the new message builds on the last answer ("only the cancelled ones", "what about last month",
  "how many is that", "sort them by total", "break that down by country", "remove the date filter") or
  stands alone. A follow-up stays on the same table and is merged into the previous plan in code:
  new conditions are added; a new value on the same column *replaces* the old one ("Lisbon instead");
  a new period replaces the old period; the result shape, calculation, grouping, sort and limit carry
  over unless the follow-up changes them; and one yes/no per previous condition asks whether it should be
  dropped. The answer is tagged "↳ follow-up to …" with an **ask as a new question** link that re-reads
  it without context. Follow-up chips ("↳ show them") appear first in the suggestion row. Edits made
  through Adjust carry into the next follow-up. The plan coming back from the browser is untrusted and
  is only used if it compiles against the live catalog.
- Each answer has three drawers: **How I read it** (every judgment with its probability and runner-ups),
  **SQL** (copy, or open in the editor) and **Adjust** (edit the plan; recompiles with no new inference).

## How Ask works with Jev

Jev does not generate text, so it cannot write SQL. It returns typed judgments — a **Choice** among
options or a **Noul** (yes/no probability) — in a few hundred milliseconds. So this app never asks for
SQL. Code owns the query; Jev supplies the understanding:

1. **Route** (1 request). State = the question + every table with its columns and comments.
   One Choice picks the main table (with a "none of these" option); one Noul per table asks whether
   the question needs it. Code then finds foreign-key join paths between them.
2. **Plan** (1 request, speculative fan-out). State = the question, today's date, and the columns of the
   tables involved. Dozens of independent questions are asked at once: result shape, calculation,
   calculated column, group-by column, time bucket, sort column and direction, which columns to show,
   and — for every candidate literal — what it means:
   - *category values*: for enum, boolean and low-cardinality text columns the real values are read from
     the catalog and each gets its own yes/no, so "Japan or Brazil" becomes an `IN` filter;
   - *numbers*: found by regex; Jev says whether each is a row limit, or a comparison against which
     column with which operator;
   - *time*: asked only when the question contains time wording (a rule code can check); Jev picks the period ("last month", "this year", a named month/year) and the date column;
     code does all date arithmetic;
   - *empty values*: for nullable columns, Jev says whether the question needs the column empty
     ("never logged in", "not shipped yet"), filled in, or neither;
   - *exclusions*: when the question contains negation wording (not, except, other than, outside,
     but, …; a rule code checks), each category value and search term also gets a "is it ruled out?"
     yes/no, and each number a "is the comparison negated?". An exclusion beats "wanted" values the
     question never names, "not over 500" flips to "at most 500" exactly once, and the SQL is NULL-safe
     (`is distinct from`, `is null or … <> all(…)`), so "not cancelled" keeps rows with no status;
   - *search terms*: n-grams of the question that aren't schema words; Jev says which column, if any,
     each would be found in.
3. **Alternatives** (1 request, only when needed). Which conditions are joined by "or" can only be
   judged once the conditions are known. When the question says "or"/"either" and produced conditions
   on at least two different columns, each condition gets one yes/no: is it one side of an "or"?
   Those that are compile into a single `( … or … )` group, ANDed with everything else. "Japan or
   Brazil" stays a same-column list; "cancelled or over 5000" becomes an OR group; a table reached only
   through an alternative is LEFT-joined so rows that satisfy the other alternative are not lost.
4. **Compose** (code). The answers become a small plan object. `server/nl/compile.js` turns it into SQL:
   every identifier is resolved through the catalog, every keyword through a whitelist, every value is a
   bound parameter. The query runs in a read-only transaction with a timeout.

Each judgment is shown with its probability and runner-up options. Jev's probabilities move slightly
between calls, so nothing is decided on a coin-flip: category values and time periods need 0.6,
conditions Jev *inferred* rather than read (an empty column) need 0.85, and a weak sort preference falls
back to a fixed default. Anything below its bar is listed as a suggestion but not applied. Editing the plan (result shape, calculation, grouping, sort, limit, removing a filter)
recompiles the SQL in code with **no new inference**; choosing a different main table re-plans.

Typical cost is ~4–5k input tokens and well under a second per question; negation wording adds questions to
the same request, and an "or" across columns adds one small request.

### Limits

Jev selects; it cannot invent. Questions need to map onto one main table plus FK-reachable tables, with
filters whose values appear in the question. Supported logic: AND, exclusions ("not cancelled",
"neither … nor", "other than", "not over 500"), percentages of a whole, lists on one column ("Japan or Brazil") and one OR group
across columns ("cancelled or over 5000"). Not supported: anti-joins ("customers without any orders"),
nested or multiple OR groups, excluding a time period, subqueries, HAVING, window functions, arithmetic
between columns, comparisons between two aggregates. For those, use "Open in SQL
editor" and continue by hand. Very large schemas are capped at 150 tables and 120 columns per question.
Low-cardinality text values come from `pg_stats`. On a database that was never ANALYZEd, tables under
16 MB are sampled directly instead (row count plus up to 26 distinct values of each short text column), so
status-like values still work; larger unanalyzed tables need `ANALYZE`.

## Create: the database designer

Describe what you need in plain English and Create drafts it: a whole schema ("build me a database for a
vet clinic"), a table ("create a table called invoices with number, amount, due date and status (draft,
sent, paid)"), or a change to what exists ("make phone optional", "orders belong to customers", "index
orders by placed at", "create a read-only role called analyst", "fill every table with 50 sample rows",
"review my schema"). **New database** creates one on the connected server and opens it.

Nothing touches the database while you talk. Every request adds to a **draft**, shown four ways:

- **Diagram**: the schema as it would be, with added, changed and dropped parts coloured.
- **Changes**: each staged change in the order it will run, with its warnings. Tables still in the draft
  can be edited in place (types, required, unique, remove a column) and each design convention is a switch.
- **SQL**: the exact migration.
- **Advisor**: a DBA's review of the draft: missing primary keys, foreign keys without an index, timestamps
  without a time zone, money stored as floats, `varchar(255)`, nullable booleans, `_id` columns with no
  constraint, duplicate indexes, row-level security with no policy, naming. Most findings have a one-click fix.

**Apply** first runs the whole migration and rolls it back (a trial run, so a NOT NULL that would fail on
existing rows is caught before anything changes), then asks for confirmation, then runs it as **one
transaction**: all of it lands or none of it does. A migration that deletes data (drop table, drop column,
a narrowing type change) requires typing the database name, and the server enforces that, not just the
page. If the schema changed since the preview, Apply refuses and shows the refreshed draft. Applied
migrations are logged in `migrations.local.json` (git-ignored, this machine only); the latest one can be
undone from **History** when every step is reversible.

### How Create works with Jev

Jev cannot write SQL or invent a name, so, as in Ask, code proposes and Jev selects:

1. **Read** (two parallel requests). One sees the request and the existing tables and decides the kind of
   change, the target table and which tables are involved. The other sees *only the request* and decides
   what each phrase in it is (table name, field name, allowed value, role name, …) and which blueprint
   fits. They are separate because state leaks: with an online store's tables in view, "a database for
   a vet clinic" was judged to be an online store.
2. **Detail** (one request). Everything the chosen kind of change needs, asked at once: what kind of field
   each name is (one of ~30 *archetypes*), whether it was said to be required or unique, how two tables
   relate and what happens on delete, which optional parts of a blueprint were asked for, and so on.
3. **Compile**. Code turns the answers into ops, replays them on the live schema, and emits SQL.

The expertise is code, not model output. An **archetype** (`server/create/archetypes.js`) fixes what a DBA
would do with a field: `email` is `text`, unique, lowercase-checked; `money` is `numeric(12,2)` and
non-negative; a status with listed values becomes an enum with a default. **Conventions** give every
table a `bigint` identity key and `timestamptz` audit columns, and index every foreign key. **Blueprints**
(`server/create/blueprints/`) are ten declarative domain designs (store, blog, CRM, SaaS, clinic/booking,
inventory, courses, helpdesk, HR, ledger); Jev picks one, picks its optional parts, and maps the user's own
words onto its entities ("pets" for patients). Names that settle the question (`*_at`, `is_*`, `price`)
are decided by rule and shown as such.

Thresholds follow the same principle as Ask: 0.6 for something the request states, 0.85 for something
it only implies (cascade on delete, many-to-many) and for anything destructive, 0.75 for a blueprint's
optional parts (measured: ≥ 0.89 when asked for, ≤ 0.59 when not). Below the bar a change is offered as a
suggestion and never staged.

**Safety.** A draft is a list of ops, and the browser's copy is untrusted: every view and every apply
rebuilds each op field by field (`ops.js`), replays it on the live schema and recompiles. SQL is assembled
only from quoted identifiers, quoted literals and whitelists of types, actions, privileges and
check/default/policy templates; there is no free SQL expression anywhere in an op. New names must be
plain snake_case, not reserved, at most 63 bytes. Roles are always created `NOLOGIN`: a password never
passes through the chat or the model. Only the request text and table, column and role names go to TypeSafe.

### Limits

Jev selects; it cannot invent. A name must appear in your message or in a blueprint, so "a table for the
things people buy" gets a question back, not a guess. One kind of change per message. Domains outside the
ten blueprints start as plain named tables for you to fill in. Sample data is plausible, not realistic,
and triggers or hand-written checks on existing tables can reject it (the trial run says which). Not
covered: views, functions, triggers, partitioning, composite foreign keys, converting existing data to an
enum. For those, **Open in SQL editor**. Identity columns need Postgres 10+, `gen_random_uuid()` 13+.

To re-check Jev's readings after changing a question or threshold, connect the app to a scratch database
with the online-store blueprint applied and run `node scripts/creator-regression.mjs` (25 requests × 3,
reports flips). `node scripts/creator-blueprints-live.mjs` dry-runs every blueprint plus sample data.

## Layout

```
server/index.js        HTTP API (Express)
server/db.js           connection pool, read-only SQL runner
server/introspect.js   catalog queries for the explorer
server/saved.js        saved connections file (passwords stay server-side)
server/jev.js          TypeSafe System One client (fetch)
server/nl/model.js     schema model + foreign-key graph
server/nl/candidates.js literal extraction and date arithmetic
server/nl/index.js     the questions, and assembling answers into a plan
server/nl/assistant.js answer wording, catalog/structure answers, schema-tailored suggestions
server/nl/followup.js  conversation context: validating it, describing it to Jev, merging a follow-up
server/nl/compile.js   plan → parameterized SQL
server/create/design.js     the schema as plain JSON, read from the catalog; diagram diff; fingerprint
server/create/ops.js        the op vocabulary; rebuilds untrusted ops field by field
server/create/compile.js    replays ops on the design → validated draft + SQL + inverse ops
server/create/types.js      whitelists: column types, defaults, checks, FK actions, privileges, policies
server/create/validate.js   identifier rules, name generation, FK checks
server/create/understand.js the Jev questions for Create, and turning answers into ops
server/create/access.js     roles, grants and row-level security by natural language
server/create/archetypes.js field archetypes: type, constraints, default, sample-data generator
server/create/blueprints/   declarative whole-domain designs
server/create/advisor.js    schema review rules (no model)
server/create/seed.js       FK-consistent sample data
server/create/apply.js      trial run + one-transaction apply; history.js logs it
server/create/wording.js    everything Create says
public/                no-build vanilla JS frontend (create.js, erd.js and chat.js are shared by Ask, Relationships and Create)
test/                  node --test (compiler, injection, dates, candidates, assistant wording, follow-ups; create.test.js covers the Creator engine)
```
