import { randomUUID } from "node:crypto";

import type { BackendClient } from "../backend/client.ts";
import { SAMPLE } from "./sample.ts";
import {
  rememberMessageId,
  wasMessageProcessed,
  type StateStore,
} from "./store.ts";
import type {
  BridgeUpdate,
  ChatTurn,
  DemoState,
  EventRecord,
  Member,
  PendingQuestion,
  PlanStatus,
  QuestionKind,
  RsvpStatus,
} from "./types.ts";

const MAX_CHAT_TURNS = 24;

export type SaveResult =
  | { ok: true; state: DemoState }
  | { ok: false; error: string; state: DemoState };

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.trim().startsWith("+")) return `+${digits}`;
  return phone.trim();
}

/**
 * Bridge data ops: local file store + optional Flask sync.
 * Photon code should only talk to this class.
 */
export class MeadowRepository {
  constructor(
    private readonly store: StateStore,
    private readonly backend: BackendClient | null = null
  ) {}

  async load(): Promise<DemoState> {
    return this.store.load();
  }

  async getEvent(eventId: string = SAMPLE.eventId): Promise<EventRecord | null> {
    const state = await this.store.load();
    return state.events[eventId] ?? null;
  }

  async resolveMember(
    spaceId: string,
    platformUserId: string | null
  ): Promise<{ member: Member; newlyLinked: boolean } | null> {
    const state = await this.store.load();
    const bySpace = Object.values(state.members).find((m) => m.spaceId === spaceId);
    if (bySpace) {
      if (platformUserId && bySpace.platformUserId !== platformUserId) {
        bySpace.platformUserId = platformUserId;
        const saved = await this.persist(state);
        if (!saved.ok) return null;
        return { member: bySpace, newlyLinked: false };
      }
      return { member: bySpace, newlyLinked: false };
    }

    if (platformUserId) {
      const phone = normalizePhone(platformUserId);
      const byPhone = Object.values(state.members).find(
        (m) => m.phone && normalizePhone(m.phone) === phone
      );
      if (byPhone) {
        byPhone.spaceId = spaceId;
        byPhone.platformUserId = platformUserId;
        const saved = await this.persist(state);
        if (!saved.ok) return null;
        return { member: byPhone, newlyLinked: true };
      }
    }

    const sample = state.members[SAMPLE.memberId];
    if (!sample) return null;
    if (sample.spaceId && sample.spaceId !== spaceId) return null;

    sample.spaceId = spaceId;
    sample.platformUserId = platformUserId;
    if (platformUserId) sample.phone = normalizePhone(platformUserId);
    const saved = await this.persist(state);
    if (!saved.ok) return null;
    return { member: sample, newlyLinked: true };
  }

  async upsertContact(input: {
    userId: string;
    name: string;
    phone: string;
    orgIds: string[];
  }): Promise<SaveResult & { phone?: string }> {
    const state = await this.store.load();
    const phone = normalizePhone(input.phone);
    const orgId = input.orgIds[0] ?? SAMPLE.orgId;
    if (!state.organizations[orgId]) {
      state.organizations[orgId] = {
        id: orgId,
        name: orgId === SAMPLE.orgId ? "Demo Org" : orgId,
        memberIds: [],
      };
    }
    const org = state.organizations[orgId]!;
    if (!org.memberIds.includes(input.userId)) org.memberIds.push(input.userId);

    const existing = state.members[input.userId];
    state.members[input.userId] = {
      id: input.userId,
      name: input.name || existing?.name || input.userId,
      orgId,
      phone,
      spaceId: existing?.spaceId ?? null,
      platformUserId: existing?.platformUserId ?? phone,
      recurringAvailability: existing?.recurringAvailability ?? "",
    };

    const saved = await this.persist(state);
    if (!saved.ok) return saved;

    if (this.backend?.enabled) {
      try {
        const user = await this.backend.get("users", input.userId);
        if (user) {
          await this.backend.patch("users", input.userId, {
            name: user.name,
            email: user.email ?? "",
            photo: user.photo ?? "",
            busy: user.busy ?? [],
            statusBusy: user.statusBusy ?? [],
            calendar: user.calendar ?? null,
            bridgeOptIn: user.bridgeOptIn ?? {},
            presence: user.presence ?? "offline",
            away: user.away ?? "",
            lastSeen: user.lastSeen ?? 0,
            phone,
            imessageOptIn: true,
            imessageError: "",
            version: user.version,
          });
        }
      } catch (error) {
        console.warn("[meadow] backend contact sync failed", error);
      }
    }

    return { ok: true, state: saved.state, phone };
  }

  async removeContact(userId: string): Promise<SaveResult> {
    const state = await this.store.load();
    const member = state.members[userId];
    if (member) {
      member.phone = null;
      member.spaceId = null;
      member.platformUserId = null;
    }
    const saved = await this.persist(state);
    if (!saved.ok) return saved;
    if (this.backend?.enabled) {
      try {
        const user = await this.backend.get("users", userId);
        if (user) {
          await this.backend.patch("users", userId, {
            name: user.name,
            email: user.email ?? "",
            photo: user.photo ?? "",
            busy: user.busy ?? [],
            statusBusy: user.statusBusy ?? [],
            calendar: user.calendar ?? null,
            bridgeOptIn: user.bridgeOptIn ?? {},
            presence: user.presence ?? "offline",
            away: user.away ?? "",
            lastSeen: user.lastSeen ?? 0,
            phone: "",
            imessageOptIn: false,
            imessageError: "",
            version: user.version,
          });
        }
      } catch (error) {
        console.warn("[meadow] backend contact remove failed", error);
      }
    }
    return saved;
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
    for (const [id, q] of Object.entries(state.pendingQuestions)) {
      if (
        q.memberId === input.memberId &&
        q.eventId === input.eventId &&
        q.kind === input.kind
      ) {
        delete state.pendingQuestions[id];
      }
    }
    if (!state.events[input.eventId]) {
      state.events[input.eventId] = {
        id: input.eventId,
        orgId: input.orgId,
        title: input.eventId,
        scheduledLabel: "",
        rsvps: {},
        meetingTimeVotes: {},
        foodFeedback: {},
      };
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

  async listUpdates(afterSeq: number): Promise<{
    epoch: string;
    updates: BridgeUpdate[];
  }> {
    const state = await this.store.load();
    return {
      epoch: state.updateEpoch,
      updates: state.updates.filter((u) => u.seq > afterSeq),
    };
  }

  async getChatHistory(memberId: string): Promise<ChatTurn[]> {
    const state = await this.store.load();
    return state.chatHistories[memberId] ?? [];
  }

  async appendChatTurns(
    memberId: string,
    turns: Omit<ChatTurn, "at">[]
  ): Promise<SaveResult> {
    const state = await this.store.load();
    if (!state.members[memberId]) {
      return { ok: false, error: "Unknown member.", state };
    }
    const now = new Date().toISOString();
    const existing = state.chatHistories[memberId] ?? [];
    state.chatHistories[memberId] = [
      ...existing,
      ...turns.map((t) => ({ ...t, at: now })),
    ].slice(-MAX_CHAT_TURNS);
    return this.persist(state);
  }

  /**
   * Per-event RSVP only. Syncs to Flask event.plans when backend is enabled.
   */
  async saveRsvp(
    eventId: string,
    memberId: string,
    status: RsvpStatus,
    questionId: string
  ): Promise<SaveResult> {
    return this.savePlan(
      eventId,
      memberId,
      status === "accepted" ? "going" : "cant",
      null,
      questionId
    );
  }

  /** Per-event plan (going / late / cant). Never touches recurring availability. */
  async savePlan(
    eventId: string,
    memberId: string,
    planStatus: PlanStatus,
    minutes: number | null,
    questionId: string
  ): Promise<SaveResult> {
    const state = await this.store.load();
    const event = state.events[eventId];
    const member = state.members[memberId];
    if (!event || !member) {
      return { ok: false, error: "Unknown event or member.", state };
    }
    const beforeAvailability = member.recurringAvailability;
    const beforeSchedule = event.scheduledLabel;

    const rsvpStatus: RsvpStatus =
      planStatus === "cant" ? "declined" : "accepted";
    event.rsvps[memberId] = {
      status: rsvpStatus,
      updatedAt: new Date().toISOString(),
    };
    delete state.pendingQuestions[questionId];

    const ts = Date.now();
    this.pushUpdate(state, {
      type: "plans",
      userId: memberId,
      eventId,
      orgId: event.orgId,
      status: planStatus,
      minutes,
      ts,
    });

    const saved = await this.persist(state);
    if (!saved.ok) return saved;

    const after = saved.state;
    if (
      after.members[memberId]?.recurringAvailability !== beforeAvailability ||
      after.events[eventId]?.scheduledLabel !== beforeSchedule
    ) {
      return {
        ok: false,
        error: "Save corrupted availability or schedule; refusing success.",
        state: after,
      };
    }

    const backendOk = await this.syncEventPlans(
      eventId,
      memberId,
      planStatus,
      ts,
      minutes
    );
    if (!backendOk) {
      return {
        ok: false,
        error: "Saved locally but Flask sync failed — not claiming backend update.",
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
    const ts = Date.now();
    this.pushUpdate(state, {
      type: "message",
      userId: memberId,
      eventId,
      orgId: event.orgId,
      text: `Preferred meeting time: ${choice}`,
      ts,
    });
    const saved = await this.persist(state);
    if (!saved.ok) return saved;

    if (this.backend?.enabled) {
      try {
        const remote = await this.backend.get("events", eventId);
        if (remote) {
          const votes = {
            ...((remote.meetingTimeVotes as Record<string, unknown>) || {}),
            [memberId]: { choice, ts },
          };
          await this.backend.patch("events", eventId, {
            orgId: remote.orgId,
            title: remote.title,
            start: remote.start,
            end: remote.end,
            type: remote.type ?? "Event",
            location: remote.location ?? "",
            description: remote.description ?? "",
            status: remote.status ?? "pending",
            createdBy: remote.createdBy ?? "",
            checkinCode: remote.checkinCode ?? "",
            attendance: remote.attendance ?? [],
            roles: remote.roles ?? [],
            plans: remote.plans ?? {},
            imessage: remote.imessage ?? {},
            meetingTimeVotes: votes,
            foodFeedback: remote.foodFeedback ?? {},
            version: remote.version,
          });
        }
      } catch (error) {
        console.warn("[meadow] backend time-vote sync failed", error);
        return {
          ok: false,
          error: "Saved locally but Flask sync failed — not claiming backend update.",
          state: saved.state,
        };
      }
    }
    return saved;
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
    const surveyId = `sv_${eventId}`;
    const ts = Date.now();
    this.pushUpdate(state, {
      type: "survey",
      userId: memberId,
      eventId,
      orgId: event.orgId,
      surveyId,
      answers: { food: answer },
      complete: true,
      ts,
    });
    const saved = await this.persist(state);
    if (!saved.ok) return saved;

    if (this.backend?.enabled) {
      try {
        const remote = await this.backend.get("events", eventId);
        if (remote) {
          const food = {
            ...((remote.foodFeedback as Record<string, unknown>) || {}),
            [memberId]: { answer, ts },
          };
          await this.backend.patch("events", eventId, {
            orgId: remote.orgId,
            title: remote.title,
            start: remote.start,
            end: remote.end,
            type: remote.type ?? "Event",
            location: remote.location ?? "",
            description: remote.description ?? "",
            status: remote.status ?? "pending",
            createdBy: remote.createdBy ?? "",
            checkinCode: remote.checkinCode ?? "",
            attendance: remote.attendance ?? [],
            roles: remote.roles ?? [],
            plans: remote.plans ?? {},
            imessage: remote.imessage ?? {},
            meetingTimeVotes: remote.meetingTimeVotes ?? {},
            foodFeedback: food,
            version: remote.version,
          });
        }
        await this.backend.create("guestbook", {
          eventId,
          userId: memberId,
          text: answer,
        });
      } catch (error) {
        console.warn("[meadow] backend food sync failed", error);
        return {
          ok: false,
          error: "Saved locally but Flask sync failed — not claiming backend update.",
          state: saved.state,
        };
      }
    }
    return saved;
  }

  private pushUpdate(
    state: DemoState,
    update: Omit<BridgeUpdate, "seq">
  ): void {
    state.updateSeq += 1;
    state.updates.push({ ...update, seq: state.updateSeq });
  }

  private async syncEventPlans(
    eventId: string,
    memberId: string,
    status: string,
    ts: number,
    minutes: number | null = null
  ): Promise<boolean> {
    if (!this.backend?.enabled) return true;
    try {
      const remote = await this.backend.get("events", eventId);
      if (!remote) {
        console.warn(`[meadow] backend event ${eventId} not found; local save kept`);
        return true;
      }
      const plans = {
        ...((remote.plans as Record<string, unknown>) || {}),
        [memberId]: { status, minutes, ts },
      };
      const imessage = {
        ...((remote.imessage as Record<string, unknown>) || {}),
      };
      await this.backend.patch("events", eventId, {
        orgId: remote.orgId,
        title: remote.title,
        start: remote.start,
        end: remote.end,
        type: remote.type ?? "Event",
        location: remote.location ?? "",
        description: remote.description ?? "",
        status: remote.status ?? "pending",
        createdBy: remote.createdBy ?? "",
        checkinCode: remote.checkinCode ?? "",
        attendance: remote.attendance ?? [],
        roles: remote.roles ?? [],
        plans,
        imessage,
        meetingTimeVotes: remote.meetingTimeVotes ?? {},
        foodFeedback: remote.foodFeedback ?? {},
        version: remote.version,
      });
      return true;
    } catch (error) {
      console.warn("[meadow] backend RSVP sync failed", error);
      return false;
    }
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
