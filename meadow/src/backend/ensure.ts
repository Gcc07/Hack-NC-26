/**
 * Make sure Flask has the fixed demo org / member / event that meadow writes into.
 * IDs match SAMPLE + the browser seedDemo cast (Alex Kim, Weekly General Meeting).
 */
import type { BackendClient } from "./client.ts";
import { SAMPLE } from "../data/sample.ts";

const DAY = 24 * 60 * 60 * 1000;

export async function ensureBackendBridge(backend: BackendClient): Promise<{
  ok: boolean;
  detail: string;
}> {
  if (!backend.enabled) {
    return { ok: false, detail: "backend disabled" };
  }
  if (!(await backend.health())) {
    return { ok: false, detail: "Flask down" };
  }

  const now = Date.now();
  const start = now + 2 * DAY;
  const end = start + 60 * 60 * 1000;

  try {
    await backend.ensure("users", SAMPLE.memberId, {
      name: "Alex Kim",
      email: "alex@demo.meadow",
      photo: "",
      busy: [],
      statusBusy: [],
      calendar: null,
      bridgeOptIn: {},
      presence: "online",
      away: "",
      lastSeen: 0,
      phone: "",
      imessageOptIn: true,
      imessageError: "",
    });

    const orgBody = {
      name: "Sunrise Service Society",
      emoji: "🌅",
      inviteCode: "SUNRISE",
      members: {
        [SAMPLE.memberId]: { role: "Member", joinedAt: now },
      },
      bridge: { type: "none", botId: "" },
      handoff: null,
    };
    const org = await backend.ensure("orgs", SAMPLE.orgId, orgBody);
    const members = (org.members as Record<string, unknown>) || {};
    if (!members[SAMPLE.memberId]) {
      await backend.patch("orgs", SAMPLE.orgId, {
        ...orgBody,
        members: { ...members, [SAMPLE.memberId]: { role: "Member", joinedAt: now } },
        version: org.version,
      });
    }

    await backend.ensure("events", SAMPLE.eventId, {
      orgId: SAMPLE.orgId,
      title: "Weekly General Meeting",
      start,
      end,
      type: "Meeting",
      location: "Hall 204",
      description: "iMessage bridge demo event — RSVP / time / food land here.",
      status: "pending",
      createdBy: SAMPLE.memberId,
      checkinCode: "MDW-DEMO",
      attendance: [],
      roles: [],
      plans: {},
      imessage: {},
      meetingTimeVotes: {},
      foodFeedback: {},
    });

    return {
      ok: true,
      detail: `${SAMPLE.orgId}/${SAMPLE.eventId}/${SAMPLE.memberId}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message };
  }
}
