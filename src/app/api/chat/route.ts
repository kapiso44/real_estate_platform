/**
 * POST /api/chat - a sentence in, search filters out.
 *
 * Deliberately does NOT run the search. It returns the filters and the query string; the listing
 * page then renders them from the URL, exactly as if they had been typed into the filter bar.
 * One search path, one definition of every filter, and a chat result that can be bookmarked.
 */
import { NextResponse } from "next/server";
import { getMeta } from "@/lib/offers";
import { applyRules } from "@/lib/chat/rules";
import { parseIntentLocally } from "@/lib/chat/fallback";
import { geminiConfigured, parseIntentWithGemini } from "@/lib/chat/gemini";
import { isEmptyIntent, type ParsedIntent } from "@/lib/chat/types";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 200;

// A single-process guard against a runaway client burning the API quota. Good enough for a
// single-instance app; a real deployment would put this in Redis or at the edge.
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 1000) hits.clear();
  return recent.length > RATE_LIMIT.max;
}

/** Gemini first when it is configured, the local parser whenever it is not available. */
async function parseIntent(message: string, meta: Awaited<ReturnType<typeof getMeta>>): Promise<ParsedIntent> {
  if (!geminiConfigured()) {
    return { intent: parseIntentLocally(message, meta), source: "fallback" };
  }
  try {
    return { intent: await parseIntentWithGemini(message), source: "llm" };
  } catch (error) {
    console.error("chat: Gemini call failed, using the local parser", error);
    return {
      intent: parseIntentLocally(message, meta),
      source: "fallback",
      degradedReason: "the language model could not be reached",
    };
  }
}

export async function POST(request: Request) {
  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (rateLimited(address)) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }

  let message: string;
  try {
    const body = (await request.json()) as { message?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!message) return NextResponse.json({ error: "empty_message" }, { status: 400 });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: "message_too_long", maxLength: MAX_MESSAGE_LENGTH }, { status: 400 });
  }

  try {
    const meta = await getMeta();
    const { intent, source, degradedReason } = await parseIntent(message, meta);

    // Nothing understood is a real answer, not an error: say so and change nothing.
    if (isEmptyIntent(intent)) {
      return NextResponse.json({
        understood: false,
        source,
        degradedReason,
        filters: null,
        explanations: [],
        ignored: [],
        queryString: "",
        message: "I could not turn that into a search. Try naming a district, a budget, a size or a number of rooms.",
      });
    }

    const { filters, explanations, ignored, queryString } = applyRules(intent, meta);
    return NextResponse.json({ understood: true, source, degradedReason, intent, filters, explanations, ignored, queryString });
  } catch (error) {
    console.error("POST /api/chat failed", error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
