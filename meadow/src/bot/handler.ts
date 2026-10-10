import { SAMPLE } from "../data/sample.ts";
import type { MeadowRepository } from "../data/repository.ts";
import type { Member, PendingQuestion } from "../data/types.ts";
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
  /** Replies to send back (empty if silent skip, e.g. duplicate). */
  replies: string[];
  /** True only when a durable write succeeded. */
  saved: boolean;
  duplicate?: boolean;
}

const TIME_OPTIONS = ["6:30", "8:30"] as const;
const RSVP_PROMPT =
  "🌊 Demo Org reminder: our Sample Meeting is tomorrow at 6:30 PM. Reply YES or I can't make it.";
const TIME_PROMPT =
  "Quick scheduling check for Sample Meeting — which time works better: 6:30 or 8:30?";
const FOOD_PROMPT =
  "Food feedback for Sample Meeting: how was the food (or what should we order next time)?";

/**
 * Photon-free message processing. All I/O goes through MeadowRepository so
 * the file store can be swapped for the real backend later.
 */
export async function handleInbound(
  repo: MeadowRepository,
  ctx: InboundContext
): Promise<HandlerResult> {
  if (await repo.hasProcessedMessage(ctx.messageId)) {
    return { replies: [], saved: false, duplicate: true };
  }

  const resolved = await repo.resolveMember(ctx.spaceId, ctx.platformUserId);
  if (!resolved) {
    const mark = await repo.markProcessed(ctx.messageId);
    return {
      replies: [
        "I don't recognize this chat yet. For the demo, only one sample member can be linked — reset data/demo-state.json if you need a fresh link.",
      ],
      saved: mark.ok,
    };
  }

  const { member, newlyLinked } = resolved;
  const text = normalizeText(ctx.text);
  const state = await repo.load();
  const pending = repo.pendingForMember(state, member.id);
  const prefix = newlyLinked
    ? `Linked this chat to ${member.name} (${SAMPLE.memberId}). `
    : "";

  if (isReminderCommand(text)) {
    return startQuestion(repo, ctx, member, "rsvp", RSVP_PROMPT, prefix);
  }
  if (isTimeDemoCommand(text)) {
    return startQuestion(repo, ctx, member, "meeting_time", TIME_PROMPT, prefix, [
      ...TIME_OPTIONS,
    ]);
  }
  if (isFoodDemoCommand(text)) {
    return startQuestion(repo, ctx, member, "food_feedback", FOOD_PROMPT, prefix);
  }

  const answer = await tryAnswerPending(repo, member, pending, text);
  if (answer) {
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

  const mark = await repo.markProcessed(ctx.messageId);
  const help =
    pending.length > 0
      ? `I have a pending question (${pending.map((p) => p.kind).join(", ")}). ` +
        describePending(pending) +
        " Or send REMINDER, TIME, or FOOD to start a demo prompt."
      : "Send REMINDER for the RSVP demo, TIME for the 6:30/8:30 question, or FOOD for food feedback.";

  return {
    replies: [prefix + help],
    saved: mark.ok,
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
        `${prefix}Could not save the pending question${created.ok ? "" : ` (${created.error})`}. Not claiming it was queued.`,
      ],
      saved: false,
    };
  }

  const mark = await repo.markProcessed(ctx.messageId);
  if (!mark.ok) {
    return {
      replies: [
        `${prefix}Queued the question locally, but failed to record message dedupe (${mark.error}). Prompt: ${prompt}`,
      ],
      saved: true,
    };
  }

  return { replies: [prefix + prompt], saved: true };
}

async function tryAnswerPending(
  repo: MeadowRepository,
  member: Member,
  pending: PendingQuestion[],
  text: string
): Promise<{ replies: string[]; saved: boolean } | null> {
  if (pending.length === 0) return null;

  const rsvpIntent = parseRsvpIntent(text);
  const timePending = pending.filter((p) => p.kind === "meeting_time");
  const rsvpPending = pending.filter((p) => p.kind === "rsvp");
  const foodPending = pending.filter((p) => p.kind === "food_feedback");

  // Prefer matching by reply shape so multiple pending questions can coexist.
  if (rsvpIntent && rsvpPending.length === 1 && timePending.length === 0) {
    return answerRsvp(repo, member, rsvpPending[0]!, rsvpIntent);
  }
  if (rsvpIntent && rsvpPending.length === 1 && timePending.length > 0) {
    // "yes"/"no" could be RSVP; times are numeric — still prefer RSVP for yes/no.
    return answerRsvp(repo, member, rsvpPending[0]!, rsvpIntent);
  }
  if (rsvpIntent && rsvpPending.length > 1) {
    return {
      replies: [
        "You have more than one open RSVP. Reply with the event name, or send REMINDER again to reset the sample RSVP.",
      ],
      saved: false,
    };
  }

  if (timePending.length > 0) {
    const question = timePending[0]!;
    const options = question.options?.length ? question.options : [...TIME_OPTIONS];
    const choice = parseMeetingTimeChoice(text, options);
    if (choice === "ambiguous") {
      return {
        replies: [
          `That could mean more than one time. Please reply with exactly one of: ${options.join(" or ")}.`,
        ],
        saved: false,
      };
    }
    if (choice) {
      if (timePending.length > 1) {
        return {
          replies: [
            "You have more than one open time question. Send TIME to reset the sample meeting-time question, then answer 6:30 or 8:30.",
          ],
          saved: false,
        };
      }
      return answerTime(repo, member, question, choice);
    }
  }

  if (foodPending.length === 1 && text.length > 0 && !rsvpIntent) {
    // Any non-empty non-RSVP text answers the open food question.
    // If RSVP is also pending and they said yes/no, we already handled above.
    const alsoRsvp = rsvpPending.length > 0;
    const timeHit =
      timePending.length > 0
        ? parseMeetingTimeChoice(text, [...TIME_OPTIONS])
        : null;
    if (alsoRsvp || timeHit) {
      return {
        replies: [
          "I'm not sure which question you're answering. " +
            describePending(pending) +
            " Reply YES / I can't make it for RSVP, 6:30 or 8:30 for time, or a food note for feedback.",
        ],
        saved: false,
      };
    }
    return answerFood(repo, member, foodPending[0]!, text);
  }

  if (pending.length > 1) {
    return {
      replies: [
        "I'm not sure which question you're answering. " + describePending(pending),
      ],
      saved: false,
    };
  }

  // Single pending question but reply didn't match expected shape.
  const only = pending[0]!;
  if (only.kind === "rsvp") {
    return {
      replies: ["Please reply YES or I can't make it for the Sample Meeting RSVP."],
      saved: false,
    };
  }
  if (only.kind === "meeting_time") {
    const options = only.options?.length ? only.options : [...TIME_OPTIONS];
    return {
      replies: [`Please reply with one of: ${options.join(" or ")}.`],
      saved: false,
    };
  }
  if (only.kind === "food_feedback") {
    return {
      replies: ["Send a short note about the food (anything is fine)."],
      saved: false,
    };
  }

  return null;
}

function describePending(pending: PendingQuestion[]): string {
  return pending
    .map((p) => {
      if (p.kind === "rsvp") return "RSVP → YES or I can't make it";
      if (p.kind === "meeting_time") {
        const opts = p.options?.length ? p.options : [...TIME_OPTIONS];
        return `meeting time → ${opts.join(" or ")}`;
      }
      return "food feedback → a short note";
    })
    .join("; ");
}

async function answerRsvp(
  repo: MeadowRepository,
  member: Member,
  question: PendingQuestion,
  intent: "accept" | "decline"
): Promise<{ replies: string[]; saved: boolean }> {
  const status = intent === "accept" ? "accepted" : "declined";
  const saved = await repo.saveRsvp(
    question.eventId,
    member.id,
    status,
    question.id
  );
  if (!saved.ok) {
    return {
      replies: [
        `I couldn't save your RSVP (${saved.error}). You're not marked ${status} yet.`,
      ],
      saved: false,
    };
  }

  const event = saved.state.events[question.eventId];
  const availability = saved.state.members[member.id]?.recurringAvailability;

  if (intent === "decline") {
    return {
      replies: [
        `Got it — you're marked as unable to attend ${event?.title ?? "the event"} only. ` +
          `Your recurring availability (${availability}) is unchanged, and the meeting was not rescheduled.`,
      ],
      saved: true,
    };
  }

  // After accept, queue the meeting-time question for the demo chain.
  const timeQ = await repo.createPendingQuestion({
    kind: "meeting_time",
    orgId: question.orgId,
    eventId: question.eventId,
    memberId: member.id,
    prompt: TIME_PROMPT,
    options: [...TIME_OPTIONS],
  });
  if (!timeQ.ok) {
    return {
      replies: [
        `You're marked as attending ${event?.title ?? "the event"}! ` +
          `(Could not queue the follow-up time question: ${timeQ.error}.)`,
      ],
      saved: true,
    };
  }

  return {
    replies: [
      `You're marked as attending ${event?.title ?? "the event"}!`,
      TIME_PROMPT,
    ],
    saved: true,
  };
}

async function answerTime(
  repo: MeadowRepository,
  member: Member,
  question: PendingQuestion,
  choice: string
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
        `I couldn't save your time preference (${saved.error}). Nothing was recorded yet.`,
      ],
      saved: false,
    };
  }

  const foodQ = await repo.createPendingQuestion({
    kind: "food_feedback",
    orgId: question.orgId,
    eventId: question.eventId,
    memberId: member.id,
    prompt: FOOD_PROMPT,
  });
  if (!foodQ.ok) {
    return {
      replies: [
        `Saved your preference for ${choice}. (Could not queue food feedback: ${foodQ.error}.)`,
      ],
      saved: true,
    };
  }

  return {
    replies: [`Saved — you prefer ${choice} for Sample Meeting.`, FOOD_PROMPT],
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
        `I couldn't save your food feedback (${saved.error}). Nothing was recorded yet.`,
      ],
      saved: false,
    };
  }

  return {
    replies: [
      `Thanks — saved your food feedback for Sample Meeting under ${member.name} / ${question.orgId} / ${question.eventId}.`,
    ],
    saved: true,
  };
}
