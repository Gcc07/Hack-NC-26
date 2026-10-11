import { randomUUID } from "node:crypto";

import { SAMPLE } from "./sample.ts";
import {
  rememberMessageId,
  wasMessageProcessed,
  type StateStore,
} from "./store.ts";
import type {
  DemoState,
  EventRecord,
  Member,
  PendingQuestion,
  QuestionKind,
  RsvpStatus,
} from "./types.ts";

export type SaveResult =
  | { ok: true; state: DemoState }
  | { ok: false; error: string; state: DemoState };

/**
 * Data operations for Meadow's iMessage bridge.
 * Photon messaging code should call this — never touch the file store directly.
 * Replace FileStateStore later with a real backend client implementing StateStore.
 */
export class MeadowRepository {
  constructor(private readonly store: StateStore) {}

  async load(): Promise<DemoState> {
    return this.store.load();
  }

  async getEvent(eventId: string = SAMPLE.eventId): Promise<EventRecord | null> {
    const state = await this.store.load();
    return state.events[eventId] ?? null;
  }

  async findMemberBySpace(spaceId: string): Promise<Member | null> {
    const state = await this.store.load();
    return (
      Object.values(state.members).find((m) => m.spaceId === spaceId) ?? null
    );
  }

  /**
   * Demo convenience: bind the sample member to the first space that texts in.
   * Returns null if the space maps to no member and the sample member is already bound elsewhere.
   */
  async resolveMember(
    spaceId: string,
    platformUserId: string | null
  ): Promise<{ member: Member; newlyLinked: boolean } | null> {
    const state = await this.store.load();
    const existing = Object.values(state.members).find((m) => m.spaceId === spaceId);
    if (existing) {
      if (platformUserId && existing.platformUserId !== platformUserId) {
        existing.platformUserId = platformUserId;
        const saved = await this.persist(state);
        if (!saved.ok) return null;
        return { member: existing, newlyLinked: false };
      }
      return { member: existing, newlyLinked: false };
    }

    const sample = state.members[SAMPLE.memberId];
    if (!sample) return null;
    if (sample.spaceId && sample.spaceId !== spaceId) return null;

    sample.spaceId = spaceId;
    sample.platformUserId = platformUserId;
    const saved = await this.persist(state);
    if (!saved.ok) return null;
    return { member: sample, newlyLinked: true };
  }

  async hasProcessedMessage(messageId: string): Promise<boolean> {
    const state = await this.store.load();
    return wasMessageProcessed(state, messageId);
  }

  async markProcessed(messageId: string): Promise<SaveResult> {
    const state = await this.store.load();
    rememberMessageId(state, messageId);
    return this.persist(state);
  }

  pendingForMember(state: DemoState, memberId: string): PendingQuestion[] {
    return Object.values(state.pendingQuestions).filter((q) => q.memberId === memberId);
  }

  async createPendingQuestion(input: {
    kind: QuestionKind;
    orgId: string;
    eventId: string;
    memberId: string;
    prompt: string;
    options?: string[];
  }): Promise<SaveResult & { question?: PendingQuestion }> {
    const state = await this.store.load();
    // One pending question per kind per member+event (replace older of same kind).
    for (const [id, q] of Object.entries(state.pendingQuestions)) {
      if (
        q.memberId === input.memberId &&
        q.eventId === input.eventId &&
        q.kind === input.kind
      ) {
        delete state.pendingQuestions[id];
      }
    }
    const question: PendingQuestion = {
      id: `pq_${randomUUID()}`,
      kind: input.kind,
      orgId: input.orgId,
      eventId: input.eventId,
      memberId: input.memberId,
      prompt: input.prompt,
      options: input.options,
      createdAt: new Date().toISOString(),
    };
    state.pendingQuestions[question.id] = question;
    const saved = await this.persist(state);
    if (!saved.ok) return saved;
    return { ok: true, state: saved.state, question };
  }

  async clearPending(questionId: string): Promise<SaveResult> {
    const state = await this.store.load();
    delete state.pendingQuestions[questionId];
    return this.persist(state);
  }

  /**
   * Per-event RSVP only. Does not touch recurringAvailability or event schedule.
   */
  async saveRsvp(
    eventId: string,
    memberId: string,
    status: RsvpStatus,
    questionId: string
  ): Promise<SaveResult> {
    const state = await this.store.load();
    const event = state.events[eventId];
    const member = state.members[memberId];
    if (!event || !member) {
      return { ok: false, error: "Unknown event or member.", state };
    }
    if (member.orgId !== event.orgId) {
      return { ok: false, error: "Member is not in this event's organization.", state };
    }
    const beforeAvailability = member.recurringAvailability;
    const beforeSchedule = event.scheduledLabel;

    event.rsvps[memberId] = { status, updatedAt: new Date().toISOString() };
    delete state.pendingQuestions[questionId];

    const saved = await this.persist(state);
    if (!saved.ok) return saved;

    // Guardrails: declines must not rewrite availability or reschedule.
    const after = saved.state;
    const afterMember = after.members[memberId];
    const afterEvent = after.events[eventId];
    if (
      !afterMember ||
      !afterEvent ||
      afterMember.recurringAvailability !== beforeAvailability ||
      afterEvent.scheduledLabel !== beforeSchedule
    ) {
      return {
        ok: false,
        error: "Save corrupted availability or schedule; refusing success.",
        state: after,
      };
    }
    return saved;
  }

  async saveMeetingTimeVote(
    eventId: string,
    memberId: string,
    choice: string,
    questionId: string
  ): Promise<SaveResult> {
    const state = await this.store.load();
    const event = state.events[eventId];
    if (!event || !state.members[memberId]) {
      return { ok: false, error: "Unknown event or member.", state };
    }
    event.meetingTimeVotes[memberId] = {
      choice,
      updatedAt: new Date().toISOString(),
    };
    delete state.pendingQuestions[questionId];
    return this.persist(state);
  }

  async saveFoodFeedback(
    eventId: string,
    memberId: string,
    answer: string,
    questionId: string
  ): Promise<SaveResult> {
    const state = await this.store.load();
    const event = state.events[eventId];
    if (!event || !state.members[memberId]) {
      return { ok: false, error: "Unknown event or member.", state };
    }
    event.foodFeedback[memberId] = {
      answer,
      updatedAt: new Date().toISOString(),
    };
    delete state.pendingQuestions[questionId];
    return this.persist(state);
  }

  private async persist(state: DemoState): Promise<SaveResult> {
    try {
      await this.store.save(state);
      const reloaded = await this.store.load();
      return { ok: true, state: reloaded };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, state };
    }
  }
}
