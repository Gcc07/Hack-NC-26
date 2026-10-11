/** Normalize inbound text for simple explicit matching (no LLM). */
export function normalizeText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

export function isReminderCommand(text: string): boolean {
  return text === "reminder";
}

export function isTimeDemoCommand(text: string): boolean {
  return text === "time" || text === "meeting time";
}

export function isFoodDemoCommand(text: string): boolean {
  return text === "food" || text === "survey" || text === "feedback";
}

export type RsvpIntent = "accept" | "decline" | null;

export function parseRsvpIntent(text: string): RsvpIntent {
  if (
    text === "yes" ||
    text === "y" ||
    text === "yeah" ||
    text === "yep" ||
    text === "i'll be there" ||
    text === "ill be there" ||
    text === "attending"
  ) {
    return "accept";
  }
  if (
    text === "no" ||
    text === "n" ||
    text === "nah" ||
    text === "i can't make it" ||
    text === "i cant make it" ||
    text === "can't make it" ||
    text === "cant make it" ||
    text === "decline"
  ) {
    return "decline";
  }
  return null;
}

/** Map "6:30 or 8:30?" style answers to a canonical choice label. */
export function parseMeetingTimeChoice(
  text: string,
  options: string[]
): string | "ambiguous" | null {
  const cleaned = text.replace(/\s/g, "");
  const hits: string[] = [];

  for (const option of options) {
    const opt = option.toLowerCase().replace(/\s/g, "");
    if (
      text === option.toLowerCase() ||
      cleaned === opt ||
      cleaned === `${opt}pm` ||
      cleaned === `${opt}am` ||
      text.includes(option.toLowerCase())
    ) {
      hits.push(option);
      continue;
    }
    // "first" / "second" by option order
  }

  if (text === "first" || text === "1" || text === "option 1") {
    return options[0] ?? null;
  }
  if (text === "second" || text === "2" || text === "option 2") {
    return options[1] ?? null;
  }

  const unique = [...new Set(hits)];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return "ambiguous";
  return null;
}
