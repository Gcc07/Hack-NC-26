import { SAMPLE } from "../data/sample.ts";
import type { MeadowRepository } from "../data/repository.ts";
import type { Member, PendingQuestion } from "../data/types.ts";
import type { Dewey } from "./dewey.ts";
import {
  isFoodDemoCommand,
  isReminderCommand,
  isTimeDemoCommand,
  normalizeText,
  parseMeetingTimeChoice,
  parseRsvpIntent,
} from "./normalize.ts";

export interface InboundContext {
  spaceId: string;
  platformUserId: string | null;
  messageId: string;
  text: string;
}

export interface HandlerResult {
  replies: string[];
  saved: boolean;
  duplicate?: boolean;
  chat?: boolean;
}

const TIME_OPTIONS = ["6:30", "8:30"] as const;
const FALLBACK_RSVP =
  "🌊 Demo Org reminder: Sample Meeting is tomorrow at 6:30 PM. Reply YES, I can't make it, or say if you're running late.";
const FALLBACK_TIME =
  "Which time works better for Sample Meeting — 6:30 or 8:30?";
const FALLBACK_FOOD =
  "Food check for Sample Meeting: how was it, or what should we order next time?";

/**
 * Structured keywords first → Gemini NLU for messy replies → Dewey chat.
 */
export async function handleInbound(
  repo: MeadowRepository,
  ctx: InboundContext,
  dewey?: Dewey
): Promise<HandlerResult> {
  if (await repo.hasProcessedMessage(ctx.messageId)) {
    return { replies: [], saved: false, duplicate: true };
  }

  const resolved = await repo.resolveMember(ctx.spaceId, ctx.platformUserId);
  if (!resolved) {
    const mark = await repo.markProcessed(ctx.messageId);
    return {
      replies: [
        "I don't recognize this chat yet. Opt in under Me → iMessage in the app, or text after a reminder.",
      ],
      saved: mark.ok,
    };
  }

  const { member, newlyLinked } = resolved;
  const text = normalizeText(ctx.text);
  const state = await repo.load();
  const pending = repo.pendingForMember(state, member.id);
  const prefix = newlyLinked
    ? `Linked this chat to ${member.name}. `
    : "";
  const orgName =
    state.organizations[member.orgId]?.name ?? "your org";
  const event =
    state.events[pending[0]?.eventId ?? SAMPLE.eventId] ??
    state.events[SAMPLE.eventId] ??
    null;

  if (isReminderCommand(text)) {
    const prompt = dewey
      ? await dewey.composePrompt({
          kind: "reminder",
          title: event?.title ?? "Sample Meeting",
          org: orgName,
          when: event?.scheduledLabel || "soon",
          fallback: FALLBACK_RSVP,
        })
      : FALLBACK_RSVP;
    return startQuestion(repo, ctx, member, "rsvp", prompt, prefix);
  }
  if (isTimeDemoCommand(text)) {
    const prompt = dewey
      ? await dewey.composePrompt({
          kind: "meeting_time",
          title: event?.title ?? "Sample Meeting",
          org: orgName,
          options: [...TIME_OPTIONS],
          fallback: FALLBACK_TIME,
        })
      : FALLBACK_TIME;
    return startQuestion(repo, ctx, member, "meeting_time", prompt, prefix, [
      ...TIME_OPTIONS,
    ]);
  }
  if (isFoodDemoCommand(text)) {
    const prompt = dewey
      ? await dewey.composePrompt({
          kind: "food_feedback",
          title: event?.title ?? "Sample Meeting",
          org: orgName,
          fallback: FALLBACK_FOOD,
        })
      : FALLBACK_FOOD;
    return startQuestion(repo, ctx, member, "food_feedback", prompt, prefix);
  }

  // Keyword answer for open questions
  const keyword = await tryAnswerPending(repo, member, pending, text, dewey);
  if (keyword) {
    return finish(repo, ctx, prefix, keyword);
  }

  // Gemini NLU when keywords miss but something is pending (or soft RSVP in free text)
  if (dewey && (pending.length > 0 || text.length > 0)) {
    const intent = await dewey.interpret(ctx.text.trim(), pending);
    if (intent && intent.confidence >= 0.55) {
      const fromAi = await applyIntent(repo, member, pending, intent, dewey);
      if (fromAi) {
        return finish(repo, ctx, prefix, fromAi);
      }
    }
  }

  // Freeform Dewey chat
  if (dewey) {
    try {
      const chat = await dewey.chat({
        member,
        orgName,
        pending,
        eventTitle: event?.title ?? "Sample Meeting",
        userText: ctx.text.trim(),
      });
      const mark = await repo.markProcessed(ctx.messageId);
      return {
        replies: [prefix + chat.text],
        saved: chat.saved && mark.ok,
        chat: true,
      };
    } catch (error) {
      console.error("[meadow] chat path failed", error);
    }
  }

  const mark = await repo.markProcessed(ctx.messageId);
  const help =
    pending.length > 0
      ? `Open question: ${describePending(pending)}. Or just chat once Gemini is on.`
      : "Send REMINDER, TIME, or FOOD — or chat if Gemini is enabled.";
  return { replies: [prefix + help], saved: mark.ok };
}

async function finish(
  repo: MeadowRepository,
  ctx: InboundContext,
  prefix: string,
  answer: { replies: string[]; saved: boolean }
): Promise<HandlerResult> {
  const mark = await repo.markProcessed(ctx.messageId);
  if (!mark.ok) {
    return {
      replies: [
        `${prefix}I understood your reply, but could not save it (${mark.error}). Please try again.`,
      ],
      saved: false,
    };
  }
  return {
    replies: answer.replies.map((r, i) => (i === 0 ? prefix + r : r)),
    saved: answer.saved,
  };
}

async function startQuestion(
  repo: MeadowRepository,
  ctx: InboundContext,
  member: Member,
  kind: PendingQuestion["kind"],
  prompt: string,
  prefix: string,
  options?: string[]
): Promise<HandlerResult> {
  const event = await repo.getEvent(SAMPLE.eventId);
  if (!event) {
    return { replies: ["Sample event is missing from local state."], saved: false };
  }
  const created = await repo.createPendingQuestion({
    kind,
    orgId: event.orgId,
    eventId: event.id,
    memberId: member.id,
    prompt,
    options,
  });
  if (!created.ok || !created.question) {
    return {
      replies: [
        `${prefix}Could not queue the question${created.ok ? "" : ` (${created.error})`}.`,
      ],
      saved: false,
    };
  }
  const mark = await repo.markProcessed(ctx.messageId);
  return { replies: [prefix + prompt], saved: mark.ok };
}

async function tryAnswerPending(
  repo: MeadowRepository,
  member: Member,
  pending: PendingQuestion[],
  text: string,
  dewey?: Dewey
): Promise<{ replies: string[]; saved: boolean } | null> {
  if (pending.length === 0) return null;

  const rsvpIntent = parseRsvpIntent(text);
  const rsvpPending = pending.filter((p) => p.kind === "rsvp");
  const timePending = pending.filter((p) => p.kind === "meeting_time");
  const foodPending = pending.filter((p) => p.kind === "food_feedback");

  if (rsvpIntent && rsvpPending.length === 1) {
    return answerRsvp(
      repo,
      member,
      rsvpPending[0]!,
      rsvpIntent === "accept" ? "going" : "cant",
      null,
      dewey
    );
  }

  if (timePending.length > 0) {
    const question = timePending[0]!;
    const options = question.options?.length ? question.options : [...TIME_OPTIONS];
    const choice = parseMeetingTimeChoice(text, options);
    if (choice === "ambiguous") {
      return {
        replies: [
          `That could mean more than one time. Reply with exactly one of: ${options.join(" or ")}.`,
        ],
        saved: false,
      };
    }
    if (choice && timePending.length === 1) {
      return answerTime(repo, member, question, choice, dewey);
    }
  }

  if (foodPending.length === 1 && text.length > 0 && !rsvpIntent) {
    const timeHit =
      timePending.length > 0
        ? parseMeetingTimeChoice(text, [...TIME_OPTIONS])
        : null;
    if (rsvpPending.length > 0 || timeHit) {
      return {
        replies: [
          "Not sure which question that answers. " + describePending(pending),
        ],
        saved: false,
      };
    }
    return answerFood(repo, member, foodPending[0]!, text);
  }

  // Leave mismatches for Gemini NLU / chat instead of hard-blocking.
  return null;
}

async function applyIntent(
  repo: MeadowRepository,
  member: Member,
  pending: PendingQuestion[],
  intent: {
    intent: string;
    choice: string | null;
    minutes: number | null;
    food: string | null;
    clarify: string | null;
    confidence: number;
  },
  dewey?: Dewey
): Promise<{ replies: string[]; saved: boolean } | null> {
  const rsvpQ = pending.find((p) => p.kind === "rsvp");
  const timeQ = pending.find((p) => p.kind === "meeting_time");
  const foodQ = pending.find((p) => p.kind === "food_feedback");

  if (intent.intent === "clarify") {
    return {
      replies: [
        intent.clarify?.trim() ||
          "Quick check — are you answering the RSVP, the time options, or food feedback?",
      ],
      saved: false,
    };
  }

  if (
    (intent.intent === "rsvp_accept" ||
      intent.intent === "rsvp_decline" ||
      intent.intent === "rsvp_late") &&
    rsvpQ
  ) {
    const status =
      intent.intent === "rsvp_accept"
        ? "going"
        : intent.intent === "rsvp_late"
          ? "late"
          : "cant";
    return answerRsvp(
      repo,
      member,
      rsvpQ,
      status,
      intent.minutes,
      dewey
    );
  }

  if (intent.intent === "pick_time" && timeQ && intent.choice) {
    const options = timeQ.options?.length ? timeQ.options : [...TIME_OPTIONS];
    const choice =
      parseMeetingTimeChoice(normalizeText(intent.choice), options) ||
      intent.choice;
    if (choice && choice !== "ambiguous") {
      return answerTime(repo, member, timeQ, choice, dewey);
    }
  }

  if (intent.intent === "food_answer" && foodQ) {
    const food = (intent.food || "").trim();
    if (food) return answerFood(repo, member, foodQ, food);
  }

  return null;
}

function describePending(pending: PendingQuestion[]): string {
  return pending
    .map((p) => {
      if (p.kind === "rsvp") return "RSVP → YES / can't / running late";
      if (p.kind === "meeting_time") {
        const opts = p.options?.length ? p.options : [...TIME_OPTIONS];
        return `time → ${opts.join(" or ")}`;
      }
      return "food → a short note";
    })
    .join("; ");
}

async function answerRsvp(
  repo: MeadowRepository,
  member: Member,
  question: PendingQuestion,
  status: "going" | "late" | "cant",
  minutes: number | null,
  dewey?: Dewey
): Promise<{ replies: string[]; saved: boolean }> {
  const saved = await repo.savePlan(
    question.eventId,
    member.id,
    status,
    minutes,
    question.id
  );
  if (!saved.ok) {
    return {
      replies: [
        `Couldn't save that RSVP (${saved.error}). You're not marked yet.`,
      ],
      saved: false,
    };
  }

  const event = saved.state.events[question.eventId];
  const availability = saved.state.members[member.id]?.recurringAvailability;
  const title = event?.title ?? "the event";

  if (status === "cant") {
    return {
      replies: [
        `Got it — can't make ${title} only. Recurring availability (${availability || "unchanged"}) and the schedule stay put.`,
      ],
      saved: true,
    };
  }

  if (status === "late") {
    const lateBit = minutes ? ` (~${minutes} min)` : "";
    return {
      replies: [`Noted — you're coming to ${title} but running late${lateBit}.`],
      saved: true,
    };
  }

  const timePrompt = dewey
    ? await dewey.composePrompt({
        kind: "meeting_time",
        title,
        org: question.orgId,
        options: [...TIME_OPTIONS],
        fallback: FALLBACK_TIME,
      })
    : FALLBACK_TIME;

  const timeQ = await repo.createPendingQuestion({
    kind: "meeting_time",
    orgId: question.orgId,
    eventId: question.eventId,
    memberId: member.id,
    prompt: timePrompt,
    options: [...TIME_OPTIONS],
  });
  if (!timeQ.ok) {
    return {
      replies: [
        `You're in for ${title}! (Couldn't queue the time follow-up: ${timeQ.error}.)`,
      ],
      saved: true,
    };
  }
  return {
    replies: [`You're in for ${title}!`, timePrompt],
    saved: true,
  };
}

async function answerTime(
  repo: MeadowRepository,
  member: Member,
  question: PendingQuestion,
  choice: string,
  dewey?: Dewey
): Promise<{ replies: string[]; saved: boolean }> {
  const saved = await repo.saveMeetingTimeVote(
    question.eventId,
    member.id,
    choice,
    question.id
  );
  if (!saved.ok) {
    return {
      replies: [
        `Couldn't save your time preference (${saved.error}). Nothing recorded yet.`,
      ],
      saved: false,
    };
  }

  const foodPrompt = dewey
    ? await dewey.composePrompt({
        kind: "food_feedback",
        title: "Sample Meeting",
        org: question.orgId,
        fallback: FALLBACK_FOOD,
      })
    : FALLBACK_FOOD;

  const foodQ = await repo.createPendingQuestion({
    kind: "food_feedback",
    orgId: question.orgId,
    eventId: question.eventId,
    memberId: member.id,
    prompt: foodPrompt,
  });
  if (!foodQ.ok) {
    return {
      replies: [
        `Saved — you prefer ${choice}. (Couldn't queue food feedback: ${foodQ.error}.)`,
      ],
      saved: true,
    };
  }
  return {
    replies: [`Saved — ${choice} works for you.`, foodPrompt],
    saved: true,
  };
}

async function answerFood(
  repo: MeadowRepository,
  member: Member,
  question: PendingQuestion,
  answer: string
): Promise<{ replies: string[]; saved: boolean }> {
  const saved = await repo.saveFoodFeedback(
    question.eventId,
    member.id,
    answer,
    question.id
  );
  if (!saved.ok) {
    return {
      replies: [
        `Couldn't save food feedback (${saved.error}). Nothing recorded yet.`,
      ],
      saved: false,
    };
  }
  return {
    replies: [
      `Thanks — saved your food note for ${question.eventId} under ${member.name}.`,
    ],
    saved: true,
  };
}
