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

/**
 * HTTP surface expected by js/imessage.js.
 * Runs alongside the Spectrum loop in the same meadow process.
 */
export function startBridgeServer(opts: BridgeOptions): http.Server {
  const { repo, port, mode, sendText, composeSms } = opts;

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
          recipients?: Array<{ userId: string; roleNames?: string[] }>;
          now?: boolean;
        };
        const event = body.event;
        const recipients = body.recipients || [];
        if (!event?.id || !event.orgId) {
          json(res, 400, { error: "event.id and event.orgId are required" });
          return;
        }

        const state = await repo.load();
        let reached = 0;
        const skipped: string[] = [];
        const when = eventLabel(event);
        const fallback =
          `🌊 ${event.title || "Event"} reminder (${when}). ` +
          "Reply YES, I can't make it, or say if you're running late.";
        const prompt = composeSms
          ? await composeSms({
              kind: "reminder",
              title: event.title || "Event",
              org: event.orgId || "your org",
              when,
              fallback,
            })
          : fallback;

        for (const recipient of recipients) {
          const member = state.members[recipient.userId];
          if (!member?.phone) {
            skipped.push(recipient.userId);
            continue;
          }
          const created = await repo.createPendingQuestion({
            kind: "rsvp",
            orgId: event.orgId,
            eventId: event.id,
            memberId: recipient.userId,
            prompt,
          });
          if (!created.ok) {
            skipped.push(recipient.userId);
            continue;
          }

          if (mode === "live" && sendText) {
            try {
              await sendText(member.phone, prompt);
              reached += 1;
            } catch (error) {
              console.error("[meadow] reminder send failed", recipient.userId, error);
              skipped.push(recipient.userId);
            }
          } else {
            console.log(
              `[meadow:dry] would text ${member.phone}: ${prompt}`
            );
            reached += 1;
          }
        }

        json(res, 200, { reached, skipped });
        return;
      }

      if (req.method === "POST" && url.pathname === "/surveys") {
        const body = (await readJson(req)) as {
          surveyId?: string;
          event?: { id?: string; orgId?: string; title?: string };
          recipients?: Array<{ userId: string }>;
        };
        const event = body.event;
        const recipients = body.recipients || [];
        if (!event?.id || !event.orgId) {
          json(res, 400, { error: "event.id and event.orgId are required" });
          return;
        }
        const state = await repo.load();
        let reached = 0;
        const skipped: string[] = [];
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
          const member = state.members[recipient.userId];
          if (!member?.phone) {
            skipped.push(recipient.userId);
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
            continue;
          }
          if (mode === "live" && sendText) {
            try {
              await sendText(member.phone, prompt);
              reached += 1;
            } catch {
              skipped.push(recipient.userId);
            }
          } else {
            console.log(`[meadow:dry] would text ${member.phone}: ${prompt}`);
            reached += 1;
          }
        }
        json(res, 200, { reached, skipped, surveyId: body.surveyId });
        return;
      }

      if (req.method === "POST" && url.pathname === "/availability") {
        const body = (await readJson(req)) as {
          pollId?: string;
          orgId?: string;
          title?: string;
          options?: Array<{ label: string }>;
          recipients?: Array<{ userId: string }>;
        };
        const options = (body.options || []).map((o) => o.label).filter(Boolean);
        const recipients = body.recipients || [];
        if (!body.orgId || options.length < 2) {
          json(res, 400, { error: "orgId and at least 2 options are required" });
          return;
        }
        const state = await repo.load();
        let reached = 0;
        const skipped: string[] = [];
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
          const member = state.members[recipient.userId];
          if (!member?.phone) {
            skipped.push(recipient.userId);
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
            continue;
          }
          if (mode === "live" && sendText) {
            try {
              await sendText(member.phone, prompt);
              reached += 1;
            } catch {
              skipped.push(recipient.userId);
            }
          } else {
            console.log(`[meadow:dry] would text ${member.phone}: ${prompt}`);
            reached += 1;
          }
        }
        json(res, 200, { reached, skipped, pollId: body.pollId });
        return;
      }

      if (req.method === "POST" && url.pathname === "/broadcast") {
        const body = (await readJson(req)) as {
          text?: string;
          recipients?: Array<{ userId: string }>;
        };
        const recipients = body.recipients || [];
        const text = body.text || "";
        const state = await repo.load();
        let reached = 0;
        for (const recipient of recipients) {
          const member = state.members[recipient.userId];
          if (!member?.phone || !text) continue;
          if (mode === "live" && sendText) {
            try {
              await sendText(member.phone, text);
              reached += 1;
            } catch {
              /* skip */
            }
          } else {
            console.log(`[meadow:dry] broadcast to ${member.phone}: ${text}`);
            reached += 1;
          }
        }
        json(res, 200, { reached });
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
