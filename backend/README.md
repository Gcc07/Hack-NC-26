# Meadow Flask backend

Flask serves the Meadow frontend and JSON API using process-local, in-memory
storage. The browser reads and saves shared data through `/api/state`. No database,
Firebase, or Tiger Data connection is needed.

## Run

From the repository root, using Python 3.10 or newer:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python app.py
```

On Windows, use `py -m venv .venv` and `.venv\Scripts\Activate.ps1` instead.
For just the app, install `requirements.txt`; the dev file also installs pytest.

- Open `http://127.0.0.1:5000/` to use the app.
- `GET http://127.0.0.1:5000/api` lists the API resources.
- `GET http://127.0.0.1:5000/api/health` returns `{"status":"ok"}`.
- Run tests with `python -m pytest -q` from the repository root.

## Resources

### Frontend synchronization

`GET /api/state` returns `{state, revision, instance}` in the existing frontend
shape. `PUT /api/state` accepts that shape, checks the revision and server instance,
and saves all collections atomically. A stale snapshot returns 409. The browser
then refreshes and asks the user to repeat their action; it never silently
overwrites another browser's data. All CRUD and snapshot endpoints share the same
repository. Snapshot saves update individual record versions too.

The browser waits for initial data before displaying the app, batches optimistic
edits, and polls every 1.5 seconds while visible. Save failures show a Retry button
and preserve pending changes in memory. Wait for "Connected to Meadow" before
closing the tab. The "Reset shared data" button resets the server's shared data
for everyone. Existing localStorage demo data is not automatically imported.
Per-tab selected profiles and optional local API-key settings stay in the browser;
orgs, messages, profiles, calendars, and other shared records live on the server.

### Individual records

All resources support the same endpoints:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/<resource>` | List: `{data: [...], total, limit, offset}` |
| POST | `/api/<resource>` | Create: `{data: {...}}`, HTTP 201 and `Location` header |
| GET | `/api/<resource>/<id>` | Read: `{data: {...}}` |
| PATCH | `/api/<resource>/<id>` | Update supplied fields: `{data: {...}}` |
| DELETE | `/api/<resource>/<id>` | Delete, HTTP 204 |

| Resource | Required creation fields |
| --- | --- |
| `users` | `name` |
| `friendships` | `a`, `b` (user IDs) |
| `orgs` | `name` |
| `events` | `orgId`, `title`, `start`, `end` |
| `messages` | `channel`, `userId`, `text` |
| `flares` | `eventId`, `roleId`, `createdBy` |
| `guestbook` | `eventId`, `userId`, `text` |

Field names match the frontend's camelCase records. See `models.py` for optional
fields and defaults. Availability and calendar metadata live on users; members,
bridge settings and handoffs live on orgs; roles, claims and attendance live on
events. Timestamps use Unix **milliseconds**. Channels use `org:<id>`,
`event:<id>`, or `dm:<userId>:<userId>`.

Records receive server-generated `id`, `createdAt`, `updatedAt`, and `version`
fields. These cannot be supplied at creation. PATCH requires the `version` from
the last read; a stale version returns HTTP 409 without changing the record.
Nested objects and arrays are replaced as whole values, not recursively merged.
DELETE is unconditional and removes only the specified record.

List endpoints accept exact scalar-field filters and pagination, for example:

```text
/api/messages?channel=org:abc&limit=50&offset=0
/api/events?orgId=abc
```

Lists retain creation order. `limit` defaults to 100 (maximum 500), `offset` to 0.
Errors use `{ "error": { "code": "...", "message": "..." } }`. Invalid records
return 400, missing records 404, unsupported content types 415, and requests
larger than 1 MB return 413.

## Try it

```sh
curl -X POST http://127.0.0.1:5000/api/users \
  -H 'Content-Type: application/json' \
  -d '{"name":"Maya Chen","email":"maya@example.com"}'

curl http://127.0.0.1:5000/api/users

# Substitute the returned id; a successful update increments version to 2.
curl -X PATCH http://127.0.0.1:5000/api/users/USER_ID \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"away":"In class until 3","presence":"away"}'
```

## Storage boundary and current scope

`create_app(config=None, repository=None)` creates an independent app and store.
Routes perform HTTP handling, `models.py` validates records, and
`repository.py` owns storage. The repository protocol defines list, get, create,
replace, delete, snapshot, and save_snapshot operations. An adapter can be injected later with
`create_app(repository=...)`. It must preserve detached return values and atomic
version comparisons; the in-memory implementation uses a lock for those guarantees.
The interface follows Flask's [application factory pattern](https://flask.palletsprojects.com/en/stable/patterns/appfactories/).

All records disappear on restart, including a development reloader restart.
Use one process: separate workers have separate stores. Tests create fresh apps
and use Flask's [test client](https://flask.palletsprojects.com/en/stable/testing/).

This is an unauthenticated development API. IDs linking records are stored as
references, but referential integrity and cascading deletes are not implemented.
Profile selection remains the demo's identity mechanism, not authentication.
Org permissions, role-claim rules, event status recalculation, scheduling, and
integrations still run in the frontend. Snapshot writes are atomic and reject
concurrent stale changes, but the server does not enforce those business rules.
Snapshot validation checks collection/ID structure; individual CRUD endpoints
apply the stricter schemas in `models.py`. All data is visible to connected demo
clients. Keep the API local until authentication and server-side business actions
are added.

For an optional real-browser smoke test:

```sh
python -m pip install playwright
python -m playwright install chromium
python scripts/browser_smoke.py
```

This starts its own temporary server and checks shared chat across independent
browser sessions, reload persistence, and recovery after a failed save.

## Tiger Data

The default `STORAGE_BACKEND=memory` needs no database. To use Tiger Cloud, copy
`.env.example` to `.env`, set `STORAGE_BACKEND=tiger` and `TIMESCALE_SERVICE_URL`, then run:

```sh
flask --app app tiger-init
```

That command creates the hypertables, continuous aggregates, and search tables.
Startup does not modify the database. `flask --app app tiger-index-memory` fills
optional Gemini embeddings after `GEMINI_API_KEY` is set.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/orgs/<id>/insights?days=14` | Hour-of-day activity, totals, preferred hours, check-ins |
| GET | `/api/orgs/<id>/memory?q=pizza` | Org-scoped notes, handoffs, and summaries |
| GET | `/api/ai/status` | Whether Gemini is configured (`GEMINI_API_KEY`) |
| POST | `/api/ai/parse` | `{text}` → scheduling constraints JSON from Gemini |
| POST | `/api/ai/polish` | `{text, instruction}` → rewritten text from Gemini |

`days` is 1–90. Search `limit` is 1–30. Unknown orgs return 404. A missing or
unreachable Tiger service returns 503 and does not include the connection string.
