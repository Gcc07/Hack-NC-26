/**
 * Flask Meadow API client. Secrets stay in meadow/.env — never sent to the browser.
 */

export interface BackendRecord {
  id: string;
  version: number;
  [key: string]: unknown;
}

export type SmsIntent =
  | "rsvp_accept"
  | "rsvp_decline"
  | "rsvp_late"
  | "pick_time"
  | "food_answer"
  | "clarify"
  | "chat";

export interface SmsIntentResult {
  intent: SmsIntent;
  choice: string | null;
  minutes: number | null;
  food: string | null;
  clarify: string | null;
  confidence: number;
}

export interface BackendClient {
  readonly baseUrl: string;
  readonly enabled: boolean;
  health(): Promise<boolean>;
  aiStatus(): Promise<boolean>;
  get(resource: string, id: string): Promise<BackendRecord | null>;
  patch(resource: string, id: string, body: Record<string, unknown>): Promise<BackendRecord>;
  create(resource: string, body: Record<string, unknown>): Promise<BackendRecord>;
  chat(system: string, text: string, history: Array<{ role: string; content: string }>): Promise<string | null>;
  smsIntent(
    text: string,
    pending: Array<{ kind: string; options?: string[] }>
  ): Promise<SmsIntentResult | null>;
  smsCopy(input: {
    kind: "reminder" | "meeting_time" | "food_feedback" | "availability";
    title?: string;
    org?: string;
    when?: string;
    options?: string[];
  }): Promise<string | null>;
}

class HttpBackendClient implements BackendClient {
  readonly baseUrl: string;
  readonly enabled = true;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async aiStatus(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/ai/status`);
      if (!res.ok) return false;
      const json = (await res.json()) as { enabled?: boolean };
      return !!json.enabled;
    } catch {
      return false;
    }
  }

  async get(resource: string, id: string): Promise<BackendRecord | null> {
    const res = await fetch(`${this.baseUrl}/api/${resource}/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${resource}/${id} failed (${res.status})`);
    const json = (await res.json()) as { data: BackendRecord };
    return json.data;
  }

  async patch(
    resource: string,
    id: string,
    body: Record<string, unknown>
  ): Promise<BackendRecord> {
    const res = await fetch(`${this.baseUrl}/api/${resource}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`PATCH ${resource}/${id} failed (${res.status}) ${err.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: BackendRecord };
    return json.data;
  }

  async create(resource: string, body: Record<string, unknown>): Promise<BackendRecord> {
    const res = await fetch(`${this.baseUrl}/api/${resource}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`POST ${resource} failed (${res.status}) ${err.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: BackendRecord };
    return json.data;
  }

  async chat(
    system: string,
    text: string,
    history: Array<{ role: string; content: string }>
  ): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, text, history }),
    });
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`AI chat failed (${res.status})`);
    const json = (await res.json()) as { text?: string };
    return json.text?.trim() || null;
  }

  async smsIntent(
    text: string,
    pending: Array<{ kind: string; options?: string[] }>
  ): Promise<SmsIntentResult | null> {
    const res = await fetch(`${this.baseUrl}/api/ai/sms-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, pending }),
    });
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`AI sms-intent failed (${res.status})`);
    const json = (await res.json()) as { result?: Partial<SmsIntentResult> };
    const r = json.result;
    if (!r || typeof r.intent !== "string") return null;
    return {
      intent: r.intent as SmsIntentResult["intent"],
      choice: typeof r.choice === "string" ? r.choice : null,
      minutes: typeof r.minutes === "number" ? r.minutes : null,
      food: typeof r.food === "string" ? r.food : null,
      clarify: typeof r.clarify === "string" ? r.clarify : null,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
    };
  }

  async smsCopy(input: {
    kind: "reminder" | "meeting_time" | "food_feedback" | "availability";
    title?: string;
    org?: string;
    when?: string;
    options?: string[];
  }): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/ai/sms-copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.status === 503) return null;
    if (!res.ok) throw new Error(`AI sms-copy failed (${res.status})`);
    const json = (await res.json()) as { text?: string };
    return json.text?.trim() || null;
  }
}

class DisabledBackendClient implements BackendClient {
  readonly baseUrl = "";
  readonly enabled = false;
  async health() {
    return false;
  }
  async aiStatus() {
    return false;
  }
  async get() {
    return null;
  }
  async patch(): Promise<BackendRecord> {
    throw new Error("Backend client disabled");
  }
  async create(): Promise<BackendRecord> {
    throw new Error("Backend client disabled");
  }
  async chat() {
    return null;
  }
  async smsIntent() {
    return null;
  }
  async smsCopy() {
    return null;
  }
}

export function createBackendClient(env: NodeJS.ProcessEnv = process.env): BackendClient {
  // Default to local Flask. On the team web server, meadow should still talk to
  // 127.0.0.1:5000 (gunicorn behind nginx). Override only if meadow is remote.
  const base = (env.BACKEND_URL || "http://127.0.0.1:5000").trim();
  if (!base || base === "off") return new DisabledBackendClient();
  return new HttpBackendClient(base);
}
