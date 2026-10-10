# [Project Name]

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

### Stretch
- **Flares:** backfill dropped roles by claim
- **Messaging bridge:** reach members through GroupMe or SMS (see Integration Notes)
- **Buddy list presence** and away messages
- **Event guestbook** with an AI-generated officer handoff summary
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
        |
   +----+-----------------+-----------------+
   |                      |                 |
Calendar service    Scheduling engine   AI assistant
(Google, ICS)       (constraints,       (parsing, drafting,
                     role coverage)      summarizing)
        |
     Database
```

### Proposed stack
- **Backend:** Flask (Python)
- **Database:** PostgreSQL via Supabase
- **Realtime chat and presence:** Redis Pub/Sub with WebSockets
- **Calendar:** Google Calendar API + an ICS parser
- **AI:** an LLM API for parsing, drafting, and summarizing
- **Frontend:** HTML/CSS/JS with a Frutiger Aero design system

*This is a proposal; swap anything.*

### Draft data model
- `users`, `friendships`
- `orgs`, `org_members` (with org role)
- `calendars`, `busy_blocks`
- `events`, `event_roles`, `role_claims`
- `messages` (with `channel` and `source`: app or bridged)
- `suggestions` (proposed slots with scores and reasoning)
- `guestbook_entries`

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

---

## Privacy

- Calendar data is converted to free/busy blocks on import
- Orgs see availability, never titles, locations, or attendees of private events
- Users can disconnect a calendar and delete imported data at any time
- Messaging bridges are opt-in per user

---

## Getting Started

```bash
# placeholder: fill in once the project is scaffolded
git clone <repo-url>
cd <project>
cp .env.example .env   # add Google OAuth and API keys
# install dependencies and run
```

Never commit `.env` or any API keys.

---

## Roadmap

- [ ] Auth and calendar import (Google + ICS)
- [ ] Orgs, officer/member permissions, and event roles
- [ ] Scheduling engine with ranked suggestions and role coverage
- [ ] Group chat with presence
- [ ] AI assistant for parsing and nudges
- [ ] Messaging bridge (GroupMe or SMS)
- [ ] Flares, buddy list, guestbook, and officer handoff

---

## Open Questions

- What is the best demo moment? (e.g. a tabler cancels, the assistant finds a replacement, and a member claims the shift live)
- Which org type do we design around first: a club with weekly meetings, a Greek or service org, or a project team?
- Which bridge do we build: GroupMe or SMS?
- What is the project name?

---

## License

TBD
