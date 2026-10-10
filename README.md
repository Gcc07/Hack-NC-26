# Meadow
### Meet Everyone, Anywhere, Doing Ordinary Wonders

**Discord for student org event planning.**

A coordination hub for student organizations. Officers and members share availability, an AI assistant proposes meeting and event times, members commit to specific roles (setup, tabling, food pickup, greeter), and everything runs through a group chat that also reaches people outside the app.

Built for a hackathon with a Y2K / Frutiger Aero theme. The aesthetic is not a skin: buddy lists, away messages, guestbooks, and glossy tactile buttons are the interaction model.

---

## The Problem

Student orgs run on a pile of disconnected tools: a GroupMe that goes quiet, a When2meet nobody fills out, a spreadsheet of sign-ups, and one overworked officer texting people one at a time. Every semester:

- **Meetings and events are hard to schedule.** Finding a time that works for officers, a room, and enough members takes days of back-and-forth.
- **Roles go unfilled.** "We need two people at the table Thursday" gets 12 thumbs-up reactions and zero actual commitments.
- **Cancellations break everything.** When someone drops out the night before, the officer starts over.
- **Knowledge disappears every spring.** Outgoing officers hand over a vague doc, and what worked (vendors, rooms, deadlines, lessons) is lost.

## The Idea

One place where an org can:

1. **Share availability** without exposing private calendar details
2. **Get a concrete proposal** for when to meet and when to hold an event
3. **Commit to a role** with a clear owner for each job
4. **Talk in a group chat** that is bridged to the apps members already use
5. **Remember what happened** so the next officer team inherits real knowledge

**Guiding principle: the system proposes, humans commit.** The scheduler and AI do the optimizing, but nothing is final until a person says yes to other people. The app is designed to push members toward each other, not to automate them away.

---

## Core Concepts

| Concept | Description |
|---|---|
| **Org** | A student organization with members and officers. Like a Discord server. |
| **Org roles** | Standing positions (President, Treasurer, Events Chair, Member) that control permissions: officers create and approve events, members claim roles. |
| **Event** | A planned meeting, tabling shift, social, or workshop, with a time, place, and required roles. |
| **Event roles** | Jobs for a specific event (setup crew, tabling shift, food pickup, greeter, cleanup). Each is required or optional, has a headcount, and must be claimed by a person. |
| **Buddy List** | Presence view of who is around, free now, or away, with short status messages. |
| **Friends** | Direct connections between users, for quick invites and cross-org coordination. |
| **Flare** | A request that goes out when a role opens up (e.g. someone cancels). People claim it manually. |
| **Guestbook** | Short signed notes after each event, forming the org's memory. |

---

## Features

### MVP (hackathon scope)
- **Auth and profiles:** sign in with Google
- **Calendar import:** Google Calendar connection **or** `.ics` upload (including exported class schedules)
- **Free/busy sharing:** the org only sees when someone is busy, never titles or details
- **Orgs with officer and member permissions**, joined by invite link
- **Event creation** with shift-based roles and headcounts
- **Role claiming and confirmation:** an event stays "pending" until every required role is filled
- **Slot suggestions** for officer meetings and events, ranked by who can attend
- **In-app group chat** per org and per event
- **AI scheduling assistant** that proposes times and drafts nudges (see below)
- **Tiger Data storage layer** for availability, chat history, and org memory (see [Where Tiger Data Fits](#where-tiger-data-fits))

### Stretch
- **Flares:** backfill dropped roles by claim
- **Messaging bridge:** reach members through GroupMe or SMS (see Integration Notes)
- **Buddy list presence** and away messages
- **Event guestbook** with an AI-generated officer handoff summary
- **Officer handoff search:** ask the org's history a question and get ranked answers
- **Attendance check-in** by join code or QR, feeding participation stats
- **Roster import** from a sign-up form export, with duplicate merging

---

## How Scheduling Works

The scheduling core is **deterministic**. AI sits on top of it.

**Deterministic core**
- Normalize every user's calendar into busy intervals (Google API or parsed ICS)
- Intersect free time across required attendees (officer meetings) or maximize attendance (general events)
- Check that required event roles can be covered: for each shift, are enough members free?
- Score candidate slots by attendance, role coverage, preferred hours, and buffer time
- Return a ranked list with an explanation of each score

**AI layer**
- Parses natural language ("sometime this weekend, not Sunday, need two tablers Thursday") into structured constraints
- Reads free-text statuses and replies and converts them to availability
- Drafts friendly nudges to members who haven't claimed a role
- Summarizes chat threads into decisions and open questions

**AI guardrails**
- The assistant **suggests**; it never books or assigns anyone without a human confirming
- It only sees free/busy data, not private event details
- Every suggestion shows the reasoning the deterministic scorer produced

---

## Architecture (draft)

```
Clients (web app, bridged messaging)
        |
   API server  ----  Realtime layer (chat, presence)
        |                    |
   +----+-----------------+  |  (fan-out only; durable
   |                      |  |   history is written to Tiger)
Calendar service    Scheduling engine   AI assistant
(Google, ICS)       (constraints,       (parsing, drafting,
                     role coverage)      summarizing)
        |                  |                 |
        +------------------+-----------------+
                           |
                  Tiger Data (PostgreSQL)
          hypertables | continuous aggregates | hybrid search
```

### Proposed stack
- **Backend:** Flask (Python); the initial API is in `backend/`
- **Storage:** in-memory by default. The Tiger Data adapter (Tiger Cloud, PostgreSQL with TimescaleDB) is the durable store and analytics layer, behind the same storage interface. In-memory storage stays available for local development without an account.
- **Realtime chat and presence:** Redis Pub/Sub with WebSockets (live fan-out only; Tiger holds the history)
- **Calendar:** Google Calendar API + an ICS parser
- **AI:** Google Gemini (`gemini-2.5-flash` for parsing and summarizing, `gemini-embedding-001` for semantic search), called from Flask
- **Frontend:** HTML/CSS/JS with a Frutiger Aero design system

*Beyond the initial Flask API and the storage interface, this is a proposal.*

### Draft data model
- `users`, `friendships`
- `orgs`, `org_members` (with org role)
- `calendars`, **`busy_slots`** *(hypertable)*
- `events`, `event_roles`, `role_claims`
- **`messages`** *(hypertable; has `channel` and `source`: app or bridged)*
- **`presence_events`** *(hypertable)*
- **`checkins`** *(hypertable)*
- `suggestions` (proposed slots with scores and reasoning)
- **`guestbook_entries`** *(text + embedding columns for hybrid search)*

---

## Where Tiger Data Fits

Meadow's data is mostly **timestamped and append-heavy**: busy blocks, chat, presence, check-ins. That is the shape Tiger Data (TimescaleDB on PostgreSQL) is built for. We use it in three places, where it does real work rather than acting as a generic store.

### 1. Availability as time-bucketed data (scheduling engine)

On import, every calendar is normalized into **30-minute busy slots** stored in the `busy_slots` hypertable (`user_id`, `slot_start`). Slot ranking then becomes a time-bucket query:

- "How many members are free at each slot this week?" is a `time_bucket` range query joined to `org_members`, which feeds the availability heatmap and the ranked suggestions.
- Role coverage ("are two people free for the Thursday tabling shift?") is a count over the same slots.
- Only free/busy is stored. Titles, locations, and attendees never reach the database (see Privacy).

### 2. Chat and activity as an event stream

- `messages`, `presence_events`, and `checkins` are hypertables, partitioned by time.
- Older chunks are **compressed**, so a semester of chat stays cheap to keep around.
- A **continuous aggregate** over `presence_events` and `messages` maintains each org's activity by hour of week. The scheduler reads it as a **preferred-hours signal**, so observed behavior improves future proposals.
- Check-ins roll up into per-member participation stats for officers.

### 3. Hybrid search for the officer handoff

"Knowledge disappears every spring" is the problem this solves. Guestbook entries, event notes, and chat summaries are indexed for **keyword (BM25) search plus vector (pgvector) similarity**, in the same database. An incoming officer can ask "who did we use for food last fall, and what went wrong?" and get ranked answers. Because it is all one Postgres, results join directly against `events` and `role_claims`, with no separate vector store to run.

### Optional: forks for demos and what-if checks

Tiger Cloud's zero-copy forks let us reset or branch the demo org instantly before presenting, and let the assistant test a proposed schedule on a fork before anything touches real data. That fits the principle that the system proposes and humans commit.

### Schema sketch

```sql
-- Calendars are normalized to 30-minute busy slots on import
CREATE TABLE busy_slots (
  user_id     UUID        NOT NULL,
  slot_start  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, slot_start)
);
SELECT create_hypertable('busy_slots', by_range('slot_start'));

-- Chat history (app + bridged messages)
CREATE TABLE messages (
  id          UUID        NOT NULL,
  org_id      UUID        NOT NULL,
  channel     TEXT        NOT NULL,
  source      TEXT        NOT NULL,   -- 'app' | 'groupme' | 'sms'
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, created_at)
);
SELECT create_hypertable('messages', by_range('created_at'));
```

### Storage interface

All persistence goes through the storage interface described in [backend/README.md](backend/README.md). The in-memory adapter and the Tiger adapter implement the same interface, so the app runs with or without a database.

---

## Integration Notes (read before promising features)

Student orgs mostly live in GroupMe, Discord, or an iMessage group chat, so the bridge matters. Realistic options:

| Option | Tradeoff |
|---|---|
| **GroupMe bot** | GroupMe offers a developer bot API for posting to and receiving from groups. Likely the best fit for orgs. Verify current limits and terms. |
| **SMS via a provider (e.g. Twilio)** | Reliable and documented, but not iMessage, and US carrier registration or verified-number limits apply |
| **iMessage** | **No official public API.** Apple Messages for Business needs business approval, and Mac-hosted bridges are unofficial and fragile. Treat as demo-only. |

**Hackathon recommendation:** build the in-app chat and assistant first, then add one bridge (GroupMe or SMS).

---

## Design: Y2K / Frutiger Aero

The aesthetic carries real function:

- **Skeuomorphic controls:** buttons look like buttons, so any member can use it without a tutorial
- **Glassy, translucent panels** with sky, water, and nature motifs
- **Buddy list, away messages, guestbook, and bulletin board** as actual features
- **Optional assistant mascot** in the spirit of early desktop helpers
- **Accessibility:** strong text contrast, reduced-motion support, keyboard navigation

### The Frutiger Aero scenery layer (`js/fx.js`)

A living "blue skies and green hills" backdrop, built from local libraries in `js/vendor/` (no CDN, so it works offline):

| Effect | Library |
| --- | --- |
| Animated sky and drifting clouds | Vanta.js + Three.js |
| Iridescent 3D soap bubbles you can chase with the cursor or pop by clicking | Three.js (custom thin-film shader) |
| Glossy bubbles rising behind the UI | tsParticles |
| Page and card entrances, bubble bursts, chat message pop-in | GSAP |
| 3D tilt and glare on cards and the logo | vanilla-tilt.js |
| Bloops, clicks, pops and a welcome chime (synthesized by `scripts/make_sounds.py`) | Howler.js |
| Org pulse as a glossy bubble chart | D3 |

Plus CSS-only touches: Vista-style diagonal glass gloss, sun rays, sweeping button sheen, and springy glass-orb navigation.

Judges' laptops come first: the two round buttons at the bottom-left turn the animated scenery and the sounds on or off
(remembered per browser). Effects start **off** when the OS asks for reduced motion, and the sky automatically falls back to a
static gradient if frames get slow or WebGL is unavailable. Meadow works fully without any of it.

---

## Privacy

- Calendar data is converted to free/busy slots on import; titles, locations, and attendees are never stored
- Orgs see availability, never details of private events
- Users can disconnect a calendar and delete imported data at any time
- Messaging bridges are opt-in per user

---

## Getting Started

### Run the app

Flask serves the frontend and stores shared app data in memory by default. Start everything
from the repository root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python app.py
```

Open **http://127.0.0.1:5000**. Run tests with `python -m pytest -q`.
With the default in-memory storage, data resets when the process restarts. The API is currently for local development,
without authentication. See [backend/README.md](backend/README.md) for endpoints,
examples, and the storage interface used by the Tiger Data adapter.

### Using Tiger Data

Create a Tiger Cloud service with PostgreSQL 17+ and TimescaleDB enabled. Copy `.env.example` to
`.env` (never commit it), set the connection string, and install the schema once:

```sh
STORAGE_BACKEND=tiger
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<db>?sslmode=require
flask --app app tiger-init
```

The app then stores shared Meadow data in Tiger and the Board tab reads activity from the
hypertables. Guestbook notes, event descriptions, officer handoffs, and Dewey summaries are
searchable there. Keyword search works immediately. Semantic search is optional: set
`GEMINI_API_KEY`, then run `flask --app app tiger-index-memory`.
Leave `STORAGE_BACKEND=memory` to run with no database. Cloud forks are not wired up.

### Browser demo

The HTML/CSS/JS frontend loads and saves through Flask's `/api/state` endpoint.
Tabs connected to the same server share data, with updates polled every 1.5 seconds.
The status indicator shows saving, connection failures, and retry controls. If
another tab saves first, the stale edit is rejected and you are asked to repeat
it. Use `python app.py`; opening `index.html` or the old static server alone will
not provide the API.

Click **Launch the demo org**, then use the buddy list's "Demo: be someone else" to open other members in new tabs. Optional Google sign-in / calendar import: set `GOOGLE_CLIENT_ID` in `js/config.js`. Optional Gemini upgrade for Dewey: set `GEMINI_API_KEY` in `.env` and restart (the key stays on the server).

Never commit API keys, database credentials, or client secrets.

### Git hygiene (including Windows)

Git uses **`.gitignore` on every operating system**, including Windows. The plain
`gitignore` file is a reference copy only; Git does not read it. Keep the copies
in sync when changing ignore rules. In Windows Explorer, enable **View → Show →
File name extensions** so an editor does not accidentally save `.gitignore.txt`.

Local environment files, credentials, virtual environments, databases, logs, and
editor caches are ignored. `.env.example`, `.env.sample`, and `.env.template` are
allowed for placeholder values only. Keep secrets out of frontend JavaScript:
anything served to a browser is public.

Before committing, review `git status --short` and `git diff --cached`.
Ignore rules do not protect files already tracked by Git or detect secrets pasted
into source files. If a credential was committed, revoke it; adding an ignore
rule afterward does not remove it from history.

---

## Roadmap

- [ ] Auth and calendar import (Google + ICS)
- [ ] Orgs, officer/member permissions, and event roles
- [x] Tiger Data adapter behind the storage interface (hypertables for busy slots, messages, presence)
- [ ] Scheduling engine with ranked suggestions and role coverage
- [x] Continuous aggregates for org activity, with the Board reading hypertables so the latest hour still shows up
- [ ] Group chat with presence
- [ ] AI assistant for parsing and nudges
- [x] Hybrid search over guestbook and event notes (officer handoff)
- [ ] Messaging bridge (GroupMe or SMS)
- [ ] Flares, buddy list, guestbook, and officer handoff

---

## Open Questions

- What is the best demo moment? (e.g. a tabler cancels, the assistant finds a replacement, and a member claims the shift live)
- Which org type do we design around first: a club with weekly meetings, a Greek or service org, or a project team?
- Which bridge do we build: GroupMe or SMS?
- Should the demo use Tiger Cloud forks to reset the org, or is the in-memory reset enough?

---

## License

TBD