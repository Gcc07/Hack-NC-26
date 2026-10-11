import type { DemoState } from "./types.ts";

/** Fixed IDs for local testing when the Flask backend has no matching records yet. */
export const SAMPLE = {
  orgId: "org_demo",
  eventId: "evt_sample_meeting",
  memberId: "mem_alex",
} as const;

export function createSampleState(): DemoState {
  return {
    version: 1,
    organizations: {
      [SAMPLE.orgId]: {
        id: SAMPLE.orgId,
        name: "Demo Org",
        memberIds: [SAMPLE.memberId],
      },
    },
    events: {
      [SAMPLE.eventId]: {
        id: SAMPLE.eventId,
        orgId: SAMPLE.orgId,
        title: "Sample Meeting",
        scheduledLabel: "tomorrow at 6:30 PM",
        rsvps: {},
        meetingTimeVotes: {},
        foodFeedback: {},
      },
    },
    members: {
      [SAMPLE.memberId]: {
        id: SAMPLE.memberId,
        name: "Alex",
        orgId: SAMPLE.orgId,
        phone: null,
        spaceId: null,
        platformUserId: null,
        recurringAvailability: "weeknights after 6:00 PM",
      },
    },
    pendingQuestions: {},
    chatHistories: {},
    updateEpoch: `epoch_${Date.now().toString(36)}`,
    updateSeq: 0,
    updates: [],
    processedMessageIds: [],
  };
}
