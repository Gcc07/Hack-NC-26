import type { BackendClient, SmsIntentResult } from "../backend/client.ts";
import type { MeadowRepository } from "../data/repository.ts";
import type { Member, PendingQuestion } from "../data/types.ts";

export class Dewey {
  constructor(
    private readonly repo: MeadowRepository,
    private readonly backend: BackendClient
  ) {}

  get enabled(): boolean {
    return this.backend.enabled;
  }

  async composePrompt(input: {
    kind: "reminder" | "meeting_time" | "food_feedback" | "availability";
    title: string;
    org: string;
    when?: string;
    options?: string[];
    fallback: string;
  }): Promise<string> {
    if (!this.backend.enabled) return input.fallback;
    try {
      const text = await this.backend.smsCopy({
        kind: input.kind,
        title: input.title,
        org: input.org,
        when: input.when,
        options: input.options,
      });
      return text || input.fallback;
    } catch (error) {
      console.warn("[meadow] sms-copy failed; using fallback", error);
      return input.fallback;
    }
  }

  async interpret(
    text: string,
    pending: PendingQuestion[]
  ): Promise<SmsIntentResult | null> {
    if (!this.backend.enabled) return null;
    try {
      return await this.backend.smsIntent(
        text,
        pending.map((p) => ({ kind: p.kind, options: p.options }))
      );
    } catch (error) {
      console.warn("[meadow] sms-intent failed", error);
      return null;
    }
  }

  async chat(ctx: {
    member: Member;
    orgName: string;
    pending: PendingQuestion[];
    eventTitle: string;
    userText: string;
  }): Promise<{ text: string; saved: boolean }> {
    if (!this.backend.enabled) {
      return {
        text:
          "I can chat once Flask is up with GEMINI_API_KEY. " +
          "Meanwhile try REMINDER, TIME, or FOOD.",
        saved: false,
      };
    }

    const history = await this.repo.getChatHistory(ctx.member.id);
    const pendingLine =
      ctx.pending.length === 0
        ? "None."
        : ctx.pending.map((p) => p.kind).join(", ");
    const system = [
      "You are Dewey, Meadow's iMessage assistant for student orgs.",
      "Keep replies to 1–3 short SMS sentences. Be warm and specific.",
      "Never claim you saved an RSVP, time vote, or food answer unless a structured save already happened.",
      "Declining is per-event only — do not change recurring availability or reschedule.",
      `Member: ${ctx.member.name}. Org: ${ctx.orgName}. Event context: ${ctx.eventTitle}.`,
      `Open structured questions: ${pendingLine}.`,
      "Demo triggers: REMINDER, TIME, FOOD.",
    ].join(" ");

    try {
      const reply = await this.backend.chat(
        system,
        ctx.userText,
        history.map((t) => ({ role: t.role, content: t.content }))
      );
      if (!reply) {
        return {
          text:
            "Gemini isn't enabled on the server yet (set GEMINI_API_KEY in the repo .env). " +
            "Structured demos still work: REMINDER, TIME, FOOD.",
          saved: false,
        };
      }
      const saved = await this.repo.appendChatTurns(ctx.member.id, [
        { role: "user", content: ctx.userText },
        { role: "assistant", content: reply },
      ]);
      return { text: reply, saved: saved.ok };
    } catch (error) {
      console.error("[meadow] dewey chat failed", error);
      return {
        text: "I hit a snag talking to Gemini. Try REMINDER for the structured demo.",
        saved: false,
      };
    }
  }
}
