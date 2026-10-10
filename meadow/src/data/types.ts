/** Stable domain IDs — never rely on object identity across restarts. */

export type QuestionKind = "rsvp" | "meeting_time" | "food_feedback";

export type RsvpStatus = "accepted" | "declined";

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

export interface DemoState {
  version: 1;
  organizations: Record<string, Organization>;
  events: Record<string, EventRecord>;
  members: Record<string, Member>;
  pendingQuestions: Record<string, PendingQuestion>;
  /** Recently processed inbound message ids (dedupe across restarts). */
  processedMessageIds: string[];
}
