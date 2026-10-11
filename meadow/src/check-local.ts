/**
 * Local verification without Photon / real iMessages.
 * Run: npm run check
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleInbound } from "./bot/handler.ts";
import { SAMPLE } from "./data/sample.ts";
import { MeadowRepository } from "./data/repository.ts";
import { FileStateStore } from "./data/store.ts";

let failures = 0;

function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

async function run(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "meadow-check-"));
  const statePath = path.join(dir, "demo-state.json");
  const repo = new MeadowRepository(new FileStateStore(statePath));
  const spaceId = "test-space-alex";

  console.log("1) reminder → RSVP pending");
  let r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m1",
    text: "reminder",
  });
  assert(r.saved, "reminder saved pending question");
  assert(r.replies.some((t) => /YES/i.test(t)), "reminder prompt mentions YES");

  console.log("2) duplicate message ignored");
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m1",
    text: "reminder",
  });
  assert(r.duplicate === true, "duplicate flagged");
  assert(r.replies.length === 0, "duplicate sends nothing");

  console.log("3) accept RSVP → time question (availability unchanged)");
  const before = await repo.load();
  const availabilityBefore = before.members[SAMPLE.memberId]!.recurringAvailability;
  const scheduleBefore = before.events[SAMPLE.eventId]!.scheduledLabel;
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m2",
    text: "yes",
  });
  assert(r.saved, "accept saved");
  let state = await repo.load();
  assert(state.events[SAMPLE.eventId]!.rsvps[SAMPLE.memberId]?.status === "accepted", "rsvp accepted");
  assert(
    state.members[SAMPLE.memberId]!.recurringAvailability === availabilityBefore,
    "recurring availability unchanged after accept"
  );
  assert(r.replies.some((t) => /6:30 or 8:30/.test(t)), "follow-up time question");

  console.log("4) meeting time vote → food question");
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m3",
    text: "8:30",
  });
  assert(r.saved, "time vote saved");
  state = await repo.load();
  assert(state.events[SAMPLE.eventId]!.meetingTimeVotes[SAMPLE.memberId]?.choice === "8:30", "time is 8:30");
  assert(r.replies.some((t) => /Food feedback/i.test(t)), "food follow-up");

  console.log("5) food feedback");
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m4",
    text: "pizza was great",
  });
  assert(r.saved, "food saved");
  state = await repo.load();
  assert(
    state.events[SAMPLE.eventId]!.foodFeedback[SAMPLE.memberId]?.answer === "pizza was great",
    "food answer stored"
  );

  console.log("6) decline is per-event only");
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m5",
    text: "reminder",
  });
  assert(r.saved, "second reminder saved");
  r = await handleInbound(repo, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m6",
    text: "I can't make it",
  });
  assert(r.saved, "decline saved");
  state = await repo.load();
  assert(state.events[SAMPLE.eventId]!.rsvps[SAMPLE.memberId]?.status === "declined", "rsvp declined");
  assert(
    state.members[SAMPLE.memberId]!.recurringAvailability === availabilityBefore,
    "recurring availability unchanged after decline"
  );
  assert(
    state.events[SAMPLE.eventId]!.scheduledLabel === scheduleBefore,
    "event schedule unchanged after decline"
  );
  assert(r.replies.some((t) => /unchanged/i.test(t)), "decline reply mentions unchanged availability");

  console.log("7) persistence across reload");
  const repo2 = new MeadowRepository(new FileStateStore(statePath));
  state = await repo2.load();
  assert(state.members[SAMPLE.memberId]!.spaceId === spaceId, "spaceId persisted");
  assert(state.events[SAMPLE.eventId]!.rsvps[SAMPLE.memberId]?.status === "declined", "rsvp persisted");
  const raw = await readFile(statePath, "utf8");
  assert(raw.includes(SAMPLE.memberId), "stable member id in JSON");
  assert(raw.includes(SAMPLE.eventId), "stable event id in JSON");

  console.log("8) ambiguous / help when no pending");
  r = await handleInbound(repo2, {
    spaceId,
    platformUserId: "+15555550100",
    messageId: "m7",
    text: "hello",
  });
  assert(r.replies.some((t) => /REMINDER/i.test(t)), "help mentions REMINDER");

  await rm(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll local checks passed (no real messages sent).");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
