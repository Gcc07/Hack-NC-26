/** Stable domain IDs — never rely on object identity across restarts. */

export type QuestionKind = "rsvp" | "meeting_time" | "food_feedback";

export type RsvpStatus = "accepted" | "declined";

/** Frontend/bridge plan status (maps onto event.plans). */
export type PlanStatus = "going" | "late" | "cant";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface Organization {
  id: string;
  name: string;
  memberIds: string[];
}

export interface EventRecord {
  id: string;
  orgId: string;
  title: string;
  /** Display-only sample start; declines must not mutate this. */
  scheduledLabel: string;
  /** Per-event RSVP only — not recurring availability. */
  rsvps: Record<string, { status: RsvpStatus; updatedAt: string }>;
  /** Preferred meeting-time votes for this event. */
  meetingTimeVotes: Record<string, { choice: string; updatedAt: string }>;
  /** Post-event / food feedback keyed by member. */
  foodFeedback: Record<string, { answer: string; updatedAt: string }>;
}

export interface Member {
  id: string;
  name: string;
  orgId: string;
  phone: string | null;
  /** Spectrum space.id for the DM, once known. */
  spaceId: string | null;
  /** Platform user id (phone/email handle), once known. */
  platformUserId: string | null;
  /**
   * Recurring availability is intentionally separate from per-event RSVP.
   * Declining an event must never change this field.
   */
  recurringAvailability: string;
}

export interface PendingQuestion {
  id: string;
  kind: QuestionKind;
  orgId: string;
  eventId: string;
  memberId: string;
  prompt: string;
  /** For meeting_time: allowed labels like "6:30" / "8:30". */
  options?: string[];
  createdAt: string;
}

/** Outbound update for the browser client (js/imessage.js pull). */
export interface BridgeUpdate {
  seq: number;
  type: string;
  userId: string;
  eventId?: string;
  orgId?: string;
  pollId?: string;
  surveyId?: string;
  status?: string;
  minutes?: number | null;
  picks?: number[];
  note?: string;
  answers?: Record<string, unknown>;
  complete?: boolean;
  text?: string;
  error?: string;
  ts: number;
}

export interface DemoState {
  version: 1;
  organizations: Record<string, Organization>;
  events: Record<string, EventRecord>;
  members: Record<string, Member>;
  pendingQuestions: Record<string, PendingQuestion>;
  /** Recent Dewey chat turns keyed by memberId. */
  chatHistories: Record<string, ChatTurn[]>;
  /** Frontend pull cursor; increments with each bridge update. */
  updateEpoch: string;
  updateSeq: number;
  updates: BridgeUpdate[];
  /** Recently processed inbound message ids (dedupe across restarts). */
  processedMessageIds: string[];
}
