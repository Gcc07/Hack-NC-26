import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSampleState } from "./sample.ts";
import type { DemoState, Member } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_PATH = path.resolve(__dirname, "../../data/demo-state.json");

const MAX_PROCESSED_IDS = 500;
const MAX_UPDATES = 200;

export interface StateStore {
  load(): Promise<DemoState>;
  save(state: DemoState): Promise<void>;
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceMembers(raw: Record<string, unknown>): DemoState["members"] {
  const out: DemoState["members"] = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const member = value as Partial<Member> & { id?: string };
    out[id] = {
      id: typeof member.id === "string" ? member.id : id,
      name: typeof member.name === "string" ? member.name : id,
      orgId: typeof member.orgId === "string" ? member.orgId : "",
      phone: typeof member.phone === "string" ? member.phone : null,
      spaceId: typeof member.spaceId === "string" ? member.spaceId : null,
      platformUserId:
        typeof member.platformUserId === "string" ? member.platformUserId : null,
      recurringAvailability:
        typeof member.recurringAvailability === "string"
          ? member.recurringAvailability
          : "",
    };
  }
  return out;
}

function coerceState(raw: unknown): DemoState | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  if (!isRecord(raw.organizations) || !isRecord(raw.events) || !isRecord(raw.members)) {
    return null;
  }
  if (!isRecord(raw.pendingQuestions)) return null;
  const processed = Array.isArray(raw.processedMessageIds)
    ? raw.processedMessageIds.filter((id): id is string => typeof id === "string")
    : [];
  const updates = Array.isArray(raw.updates) ? (raw.updates as DemoState["updates"]) : [];
  const chatHistories = isRecord(raw.chatHistories)
    ? (raw.chatHistories as DemoState["chatHistories"])
    : {};
  return {
    version: 1,
    organizations: raw.organizations as DemoState["organizations"],
    events: raw.events as DemoState["events"],
    members: coerceMembers(raw.members),
    pendingQuestions: raw.pendingQuestions as DemoState["pendingQuestions"],
    chatHistories,
    updateEpoch:
      typeof raw.updateEpoch === "string" ? raw.updateEpoch : `epoch_${Date.now().toString(36)}`,
    updateSeq: typeof raw.updateSeq === "number" ? raw.updateSeq : 0,
    updates: updates.slice(-MAX_UPDATES),
    processedMessageIds: processed.slice(-MAX_PROCESSED_IDS),
  };
}

/** Local JSON persistence for bridge-only state (pending questions, update queue, links). */
export class FileStateStore implements StateStore {
  readonly path: string;

  constructor(statePath: string = DEFAULT_STATE_PATH) {
    this.path = statePath;
  }

  async load(): Promise<DemoState> {
    try {
      const text = await readFile(this.path, "utf8");
      const parsed = coerceState(JSON.parse(text) as unknown);
      if (parsed) return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[meadow] could not read ${this.path}; reseeding sample data`, error);
      }
    }
    const fresh = createSampleState();
    await this.save(fresh);
    return fresh;
  }

  async save(state: DemoState): Promise<void> {
    const trimmed: DemoState = {
      ...state,
      updates: state.updates.slice(-MAX_UPDATES),
      processedMessageIds: state.processedMessageIds.slice(-MAX_PROCESSED_IDS),
    };
    await mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
    await rename(tmp, this.path);
  }
}

export function rememberMessageId(state: DemoState, messageId: string): void {
  if (state.processedMessageIds.includes(messageId)) return;
  state.processedMessageIds.push(messageId);
  if (state.processedMessageIds.length > MAX_PROCESSED_IDS) {
    state.processedMessageIds = state.processedMessageIds.slice(-MAX_PROCESSED_IDS);
  }
}

export function wasMessageProcessed(state: DemoState, messageId: string): boolean {
  return state.processedMessageIds.includes(messageId);
}
