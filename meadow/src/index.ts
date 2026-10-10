import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

import { handleInbound } from "./bot/handler.ts";
import { MeadowRepository } from "./data/repository.ts";
import { FileStateStore } from "./data/store.ts";

// Verified against installed spectrum-ts@12.10.1 / @spectrum-ts/imessage@12.10.1:
// - Spectrum({ projectId, projectSecret, providers })
// - imessage.config()
// - app.messages → AsyncIterable<[Space, Message]>
// - message.direction, message.id, message.content.type, message.sender?.id
// - space.id, space.send(string | ContentInput)
// Docs: https://photon.codes/docs/spectrum-ts

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const repo = new MeadowRepository(new FileStateStore());
await repo.load();
console.log(`[meadow] demo state ready (local file store). Commands: REMINDER, TIME, FOOD`);

for await (const [space, message] of app.messages) {
  try {
    // Filter echoed outbound sends (universal API — not iMessage-only).
    if (message.direction === "outbound") continue;
    if (message.content.type !== "text") continue;

    const result = await handleInbound(repo, {
      spaceId: space.id,
      platformUserId: message.sender?.id ?? null,
      messageId: message.id,
      text: message.content.text,
    });

    if (result.duplicate) {
      console.log(`[meadow] skip duplicate message ${message.id}`);
      continue;
    }

    for (const reply of result.replies) {
      await space.send(reply);
    }

    if (!result.saved && result.replies.length > 0) {
      console.warn(`[meadow] replied without a confirmed save for message ${message.id}`);
    }
  } catch (error) {
    console.error("[meadow] failed to process inbound message", {
      messageId: message.id,
      spaceId: space.id,
      error,
    });
    try {
      await space.send(
        "Something went wrong processing that message. Please try again in a moment."
      );
    } catch (sendError) {
      console.error("[meadow] failed to send error reply", sendError);
    }
  }
}
