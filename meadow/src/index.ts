import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

import { createBackendClient } from "./backend/client.ts";
import { Dewey } from "./bot/dewey.ts";
import { handleInbound } from "./bot/handler.ts";
import { startBridgeServer, type BridgeMode } from "./bridge/server.ts";
import { MeadowRepository } from "./data/repository.ts";
import { FileStateStore } from "./data/store.ts";

// Verified against installed spectrum-ts@12.10.1 / @spectrum-ts/imessage@12.10.1
// Docs: https://photon.codes/docs/spectrum-ts

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const backend = createBackendClient();
const repo = new MeadowRepository(new FileStateStore(), backend);
const dewey = new Dewey(repo, backend);
await repo.load();

const bridgePort = Number(process.env.BRIDGE_PORT || "5055");
const bridgeMode = ((process.env.BRIDGE_MODE || "dry").toLowerCase() === "live"
  ? "live"
  : "dry") as BridgeMode;

const im = imessage(app);
const sendText = async (phone: string, text: string) => {
  const user = await im.user(phone);
  const space = await im.space.create(user);
  await space.send(text);
};

startBridgeServer({
  repo,
  port: Number.isFinite(bridgePort) ? bridgePort : 5055,
  mode: bridgeMode,
  sendText: bridgeMode === "live" ? sendText : undefined,
  composeSms: (input) => dewey.composePrompt(input),
});

if (backend.enabled) {
  const up = await backend.health();
  const ai = up ? await backend.aiStatus() : false;
  console.log(
    `[meadow] Flask ${backend.baseUrl} — ${up ? "up" : "DOWN"}; Gemini ${ai ? "on" : "off"}`
  );
} else {
  console.log("[meadow] BACKEND_URL unset — local store only (no Gemini/Flask sync)");
}

console.log(
  `[meadow] ready — Dewey SMS + bridge mode=${bridgeMode}; demos REMINDER/TIME/FOOD`
);

for await (const [space, message] of app.messages) {
  try {
    if (message.direction === "outbound") continue;
    if (message.content.type !== "text") continue;
    const inboundText = message.content.text;

    const result = await space.responding(() =>
      handleInbound(
        repo,
        {
          spaceId: space.id,
          platformUserId: message.sender?.id ?? null,
          messageId: message.id,
          text: inboundText,
        },
        dewey
      )
    );

    if (result.duplicate) {
      console.log(`[meadow] skip duplicate message ${message.id}`);
      continue;
    }

    for (const reply of result.replies) {
      await space.send(reply);
    }

    if (!result.saved && result.replies.length > 0) {
      console.warn(
        `[meadow] replied without a confirmed save for message ${message.id}`
      );
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
