import http from "node:http";

import type { MeadowRepository } from "../data/repository.ts";

export type BridgeMode = "dry" | "live";

export interface BridgeSendText {
  (phone: string, text: string): Promise<void>;
}

export type ComposeSms = (input: {
  kind: "reminder" | "meeting_time" | "food_feedback" | "availability";
  title: string;
  org: string;
  when?: string;
  options?: string[];
  fallback: string;
}) => Promise<string>;

export interface BridgeOptions {
  repo: MeadowRepository;
  port: number;
  mode: BridgeMode;
  sendText?: BridgeSendText;
  composeSms?: ComposeSms;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function eventLabel(event: {
  title?: string;
  start?: number;
}): string {
  if (typeof event.start === "number" && event.start > 0) {
    try {
      return new Date(event.start).toLocaleString();
    } catch {
      /* fall through */
    }
  }
  return "the scheduled time";
}

type ReminderJob = {
  id: string;
  runAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type RecipientIn = {
  userId: string;
  phone?: string;
  name?: string;
  roleNames?: string[];
};

function errMsg(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "send failed");
}

/**
 * HTTP surface expected by js/imessage.js.
 * Runs alongside the Spectrum loop in the same meadow process.
 */
export function startBridgeServer(opts: BridgeOptions): http.Server {
  const { repo, port, mode, sendText, composeSms } = opts;
  const scheduled: ReminderJob[] = [];

  /** Prefer phone from the browser payload; register it on the bridge so replies work. */
  const resolvePhone = async (
    recipient: RecipientIn,
    orgId?: string
  ): Promise<{ phone: string } | { reason: string }> => {
    const state = await repo.load();
    const member = state.members[recipient.userId];
    const raw = (recipient.phone || member?.phone || "").trim();
    if (!raw) return { reason: "no_phone_on_bridge" };
    const saved = await repo.upsertContact({
      userId: recipient.userId,
      name: recipient.name || member?.name || recipient.userId,
      phone: raw,
      orgIds: orgId ? [orgId] : member?.orgId ? [member.orgId] : [],
    });
    if (!saved.ok || !saved.phone) return { reason: "contact_save_failed" };
    return { phone: saved.phone };
  };

  const runReminderSend = async (input: {
    event: {
      id: string;
      orgId: string;
      title?: string;
      start?: number;
      location?: string;
    };
    recipients: RecipientIn[];
    text?: string;
    askRsvp?: boolean;
  }): Promise<{
    reached: number;
    skipped: string[];
    errors: Array<{ userId: string; error: string }>;
  }> => {
    const { event, recipients } = input;
    const askRsvp = input.askRsvp !== false;
    let reached = 0;
    const skipped: string[] = [];
    const errors: Array<{ userId: string; error: string }> = [];
    const when = eventLabel(event);
    const fallback =
      `🌊 ${event.title || "Event"} reminder (${when}). ` +
      "Reply YES, I can't make it, or say if you're running late.";
    let prompt =
      typeof input.text === "string" && input.text.trim()
        ? input.text.trim().slice(0, 500)
        : composeSms
          ? await composeSms({
              kind: "reminder",
              title: event.title || "Event",
              org: event.orgId || "your org",
              when,
              fallback,
            })
          : fallback;
    if (!prompt) prompt = fallback;

    for (const recipient of recipients) {
      const resolved = await resolvePhone(recipient, event.orgId);
      if ("reason" in resolved) {
        skipped.push(recipient.userId);
        errors.push({ userId: recipient.userId, error: resolved.reason });
        continue;
      }
      if (askRsvp) {
        const created = await repo.createPendingQuestion({
          kind: "rsvp",
          orgId: event.orgId,
          eventId: event.id,
          memberId: recipient.userId,
          prompt,
        });
        if (!created.ok) {
          skipped.push(recipient.userId);
          errors.push({ userId: recipient.userId, error: "pending_rsvp_failed" });
          continue;
        }
      }

      if (mode === "live" && sendText) {
        try {
          await sendText(resolved.phone, prompt);
          reached += 1;
        } catch (error) {
          const msg = errMsg(error);
          console.error(
            "[meadow] reminder send failed",
            recipient.userId,
            resolved.phone,
            msg
          );
          skipped.push(recipient.userId);
          errors.push({ userId: recipient.userId, error: msg });
        }
      } else {
        console.log(`[meadow:dry] would text ${resolved.phone}: ${prompt}`);
        reached += 1;
      }
    }
    return { reached, skipped, errors };
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "OPTIONS") {
        json(res, 204, {});
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { status: "ok", mode });
        return;
      }

      if (req.method === "GET" && url.pathname === "/updates") {
        const after = Number(url.searchParams.get("after") || "0");
        const { epoch, updates } = await repo.listUpdates(
          Number.isFinite(after) ? after : 0
        );
        json(res, 200, { epoch, updates });
        return;
      }

      if (req.method === "POST" && url.pathname === "/contacts") {
        const body = (await readJson(req)) as {
          userId?: string;
          name?: string;
          phone?: string;
          orgIds?: string[];
        };
        if (!body.userId || !body.phone) {
          json(res, 400, { error: "userId and phone are required" });
          return;
        }
        const saved = await repo.upsertContact({
          userId: body.userId,
          name: body.name || body.userId,
          phone: body.phone,
          orgIds: Array.isArray(body.orgIds) ? body.orgIds : [],
        });
        if (!saved.ok) {
          json(res, 500, { error: saved.error });
          return;
        }
        json(res, 200, { phone: saved.phone });
        return;
      }

      if (req.method === "POST" && url.pathname === "/contacts/remove") {
        const body = (await readJson(req)) as { userId?: string };
        if (!body.userId) {
          json(res, 400, { error: "userId is required" });
          return;
        }
        const saved = await repo.removeContact(body.userId);
        if (!saved.ok) {
          json(res, 500, { error: saved.error });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/reminders") {
        const body = (await readJson(req)) as {
          event?: {
            id?: string;
            orgId?: string;
            title?: string;
            start?: number;
            location?: string;
          };
          recipients?: RecipientIn[];
          now?: boolean;
          /** Custom SMS body; omit for standard Dewey RSVP copy. */
          text?: string;
          /** Unix ms — if in the future, schedule instead of sending immediately. */
          sendAt?: number;
          /** When true (default), open an RSVP pending question for replies. */
          askRsvp?: boolean;
        };
        const event = body.event;
        const recipients = body.recipients || [];
        if (!event?.id || !event.orgId) {
          json(res, 400, { error: "event.id and event.orgId are required" });
          return;
        }

        const payload = {
          event: {
            id: event.id,
            orgId: event.orgId,
            title: event.title,
            start: event.start,
            location: event.location,
          },
          recipients,
          text: typeof body.text === "string" ? body.text : undefined,
          askRsvp: body.askRsvp !== false,
        };

        const sendAt =
          typeof body.sendAt === "number" && Number.isFinite(body.sendAt)
            ? body.sendAt
            : 0;
        const delay = sendAt - Date.now();
        if (!body.now && delay > 2000) {
          if (delay > 1000 * 60 * 60 * 24 * 30) {
            json(res, 400, { error: "sendAt must be within 30 days" });
            return;
          }
          const jobId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
          const timer = setTimeout(() => {
            const idx = scheduled.findIndex((j) => j.id === jobId);
            if (idx >= 0) scheduled.splice(idx, 1);
            void runReminderSend(payload).then(
              (r) =>
                console.log(
                  `[meadow] scheduled reminder ${jobId} sent reached=${r.reached} skipped=${r.skipped.length}`
                ),
              (err) => console.error(`[meadow] scheduled reminder ${jobId} failed`, err)
            );
          }, delay);
          scheduled.push({ id: jobId, runAt: sendAt, timer });
          console.log(
            `[meadow] scheduled reminder ${jobId} for ${new Date(sendAt).toISOString()} (${recipients.length} recipients)`
          );
          json(res, 200, {
            reached: 0,
            skipped: [],
            scheduled: true,
            jobId,
            sendAt,
          });
          return;
        }

        const result = await runReminderSend(payload);
        json(res, 200, { ...result, scheduled: false });
        return;
      }

      if (req.method === "GET" && url.pathname === "/reminders/scheduled") {
        json(res, 200, {
          jobs: scheduled.map((j) => ({ id: j.id, sendAt: j.runAt })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/surveys") {
        const body = (await readJson(req)) as {
          surveyId?: string;
          event?: { id?: string; orgId?: string; title?: string };
          recipients?: RecipientIn[];
        };
        const event = body.event;
        const recipients = body.recipients || [];
        if (!event?.id || !event.orgId) {
          json(res, 400, { error: "event.id and event.orgId are required" });
          return;
        }
        let reached = 0;
        const skipped: string[] = [];
        const errors: Array<{ userId: string; error: string }> = [];
        const fallback = `Food feedback for ${event.title || "the event"}: how was the food (or what should we order next time)?`;
        const prompt = composeSms
          ? await composeSms({
              kind: "food_feedback",
              title: event.title || "the event",
              org: event.orgId || "your org",
              fallback,
            })
          : fallback;

        for (const recipient of recipients) {
          const resolved = await resolvePhone(recipient, event.orgId);
          if ("reason" in resolved) {
            skipped.push(recipient.userId);
            errors.push({ userId: recipient.userId, error: resolved.reason });
            continue;
          }
          const created = await repo.createPendingQuestion({
            kind: "food_feedback",
            orgId: event.orgId,
            eventId: event.id,
            memberId: recipient.userId,
            prompt,
          });
          if (!created.ok) {
            skipped.push(recipient.userId);
            errors.push({ userId: recipient.userId, error: "pending_survey_failed" });
            continue;
          }
          if (mode === "live" && sendText) {
            try {
              await sendText(resolved.phone, prompt);
              reached += 1;
            } catch (error) {
              const msg = errMsg(error);
              console.error("[meadow] survey send failed", recipient.userId, resolved.phone, msg);
              skipped.push(recipient.userId);
              errors.push({ userId: recipient.userId, error: msg });
            }
          } else {
            console.log(`[meadow:dry] would text ${resolved.phone}: ${prompt}`);
            reached += 1;
          }
        }
        json(res, 200, { reached, skipped, errors, surveyId: body.surveyId });
        return;
      }

      if (req.method === "POST" && url.pathname === "/availability") {
        const body = (await readJson(req)) as {
          pollId?: string;
          orgId?: string;
          title?: string;
          options?: Array<{ label: string }>;
          recipients?: RecipientIn[];
        };
        const options = (body.options || []).map((o) => o.label).filter(Boolean);
        const recipients = body.recipients || [];
        if (!body.orgId || options.length < 2) {
          json(res, 400, { error: "orgId and at least 2 options are required" });
          return;
        }
        let reached = 0;
        const skipped: string[] = [];
        const errors: Array<{ userId: string; error: string }> = [];
        const fallback = `Which times work for ${body.title || "our next event"}? Reply with one of: ${options.join(" or ")}`;
        const prompt = composeSms
          ? await composeSms({
              kind: "availability",
              title: body.title || "our next event",
              org: body.orgId,
              options,
              fallback,
            })
          : fallback;

        for (const recipient of recipients) {
          const resolved = await resolvePhone(recipient, body.orgId);
          if ("reason" in resolved) {
            skipped.push(recipient.userId);
            errors.push({ userId: recipient.userId, error: resolved.reason });
            continue;
          }
          const created = await repo.createPendingQuestion({
            kind: "meeting_time",
            orgId: body.orgId,
            eventId: `poll_${body.pollId || "open"}`,
            memberId: recipient.userId,
            prompt,
            options,
          });
          if (!created.ok) {
            skipped.push(recipient.userId);
            errors.push({ userId: recipient.userId, error: "pending_poll_failed" });
            continue;
          }
          if (mode === "live" && sendText) {
            try {
              await sendText(resolved.phone, prompt);
              reached += 1;
            } catch (error) {
              const msg = errMsg(error);
              console.error("[meadow] availability send failed", recipient.userId, resolved.phone, msg);
              skipped.push(recipient.userId);
              errors.push({ userId: recipient.userId, error: msg });
            }
          } else {
            console.log(`[meadow:dry] would text ${resolved.phone}: ${prompt}`);
            reached += 1;
          }
        }
        json(res, 200, { reached, skipped, errors, pollId: body.pollId });
        return;
      }

      if (req.method === "POST" && url.pathname === "/broadcast") {
        const body = (await readJson(req)) as {
          text?: string;
          event?: { orgId?: string };
          recipients?: RecipientIn[];
        };
        const recipients = body.recipients || [];
        const text = body.text || "";
        let reached = 0;
        const skipped: string[] = [];
        const errors: Array<{ userId: string; error: string }> = [];
        if (!text) {
          json(res, 400, { error: "text is required" });
          return;
        }
        for (const recipient of recipients) {
          const resolved = await resolvePhone(recipient, body.event?.orgId);
          if ("reason" in resolved) {
            skipped.push(recipient.userId);
            errors.push({ userId: recipient.userId, error: resolved.reason });
            continue;
          }
          if (mode === "live" && sendText) {
            try {
              await sendText(resolved.phone, text);
              reached += 1;
            } catch (error) {
              const msg = errMsg(error);
              console.error("[meadow] broadcast send failed", recipient.userId, resolved.phone, msg);
              skipped.push(recipient.userId);
              errors.push({ userId: recipient.userId, error: msg });
            }
          } else {
            console.log(`[meadow:dry] broadcast to ${resolved.phone}: ${text}`);
            reached += 1;
          }
        }
        json(res, 200, { reached, skipped, errors });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      console.error("[meadow] bridge error", error);
      json(res, 500, {
        error: error instanceof Error ? error.message : "bridge error",
      });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(
      `[meadow] bridge HTTP on http://127.0.0.1:${port} (mode=${mode})`
    );
  });

  return server;
}
