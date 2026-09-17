/**
 * The one place an LLM is called at runtime.
 *
 * Its only job is to read a sentence and say what the user meant, as structured JSON. It is not
 * asked to search, to rank, to price anything or to decide what "cheap" is - rules.ts does that
 * against the real data. Keeping the model on this side of the line is what stops it inventing
 * a number that looks authoritative and is not in the dataset.
 *
 * Plain fetch against the REST endpoint rather than an SDK: it is one request, and the project
 * stays free of a dependency added for a single call.
 */
import { chatIntentSchema, CHAT_FEATURES, type ChatIntent } from "@/lib/chat/types";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
/** Per attempt. Two attempts stay inside a request the user is actually waiting on. */
const TIMEOUT_MS = 7_000;
const ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

export const geminiConfigured = (): boolean => Boolean(process.env.GEMINI_API_KEY?.trim());

const SYSTEM_PROMPT = `You turn a flat-hunting sentence into structured search intent.
The listings are flats for sale in Gdańsk, Poland. Input may be Polish or English; treat both identically.

Return ONLY what the user actually said. Rules:
- NEVER invent or compute a price, a price per m², or a threshold. If the user says "tanie", "niedrogie",
  "cheap", "affordable", "budget" without a number, set cheap=true and leave every price field null.
  Downstream code resolves that against real market medians. A number you make up would be wrong.
- Only fill budgetMax/budgetMin when the user states an amount. Normalise Polish shorthand to full PLN:
  "600 tys" / "600k" -> 600000, "1,2 mln" -> 1200000. "do X" = budgetMax, "od X" = budgetMin.
- Size: "około 40m", "~40 m2", "40-metrowe" -> areaAround=40. "minimum 50m" -> areaMin=50,
  "do 60m" -> areaMax=60. Never set areaAround together with areaMin/areaMax.
- Rooms: "2 pokoje" -> [2], "kawalerka"/"studio" -> [1], "2 lub 3 pokoje" -> [2,3]. "M3" is not a room count.
- district: only a Gdańsk district or neighbourhood name (Wrzeszcz, Przymorze, Oliwa, Zaspa, Jasień...).
  Never put "Gdańsk" itself there - the whole dataset is Gdańsk. If no place is named, leave it null.
- market: "nowe"/"od dewelopera"/"rynek pierwotny"/"new build" -> PRIMARY;
  "z drugiej ręki"/"rynek wtórny"/"używane"/"resale" -> SECONDARY.
- features: only from the allowed list, and only when the user asks for the thing itself
  ("z balkonem" -> balcony, "winda" -> elevator, "miejsce parkingowe"/"garaż" -> parking,
  "umeblowane" -> furnished, "do wprowadzenia" -> ready_to_move_in, "do remontu" -> needs_renovation).
- keywords: only descriptive wording with no field of its own ("widok na morze", "cicha okolica",
  "blisko plaży"). Never repeat a district, a price, a size, a room count or a feature here.
  Adjectives like "ładne"/"nice" carry no data - drop them rather than searching for them.
- sort: a superlative or an explicit ordering. "najdroższe"/"most expensive" -> price_desc;
  "najtańsze"/"cheapest" -> price_asc; "najlepsza cena za metr"/"best value per m²" -> price_per_m2_asc;
  "najnowsze"/"newest"/"ostatnio dodane" -> newest. "Sortuj od najdroższych" sets sort and nothing else.
  IMPORTANT: "najtańsze" (superlative) is sort=price_asc and must leave cheap null. Only a bare
  "tanie"/"cheap" with no superlative sets cheap=true. They are different requests.
- Understood nothing? Return every field null. Do not guess.`;

/** OpenAPI-subset schema; Gemini is asked to emit exactly this shape and nothing else. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    district: { type: "STRING", nullable: true },
    budgetMax: { type: "NUMBER", nullable: true },
    budgetMin: { type: "NUMBER", nullable: true },
    rooms: { type: "ARRAY", nullable: true, items: { type: "INTEGER" } },
    areaAround: { type: "NUMBER", nullable: true },
    areaMin: { type: "NUMBER", nullable: true },
    areaMax: { type: "NUMBER", nullable: true },
    cheap: { type: "BOOLEAN", nullable: true },
    market: { type: "STRING", nullable: true, enum: ["PRIMARY", "SECONDARY"] },
    features: { type: "ARRAY", nullable: true, items: { type: "STRING", enum: [...CHAT_FEATURES] } },
    keywords: { type: "STRING", nullable: true },
    sort: { type: "STRING", nullable: true, enum: ["price_desc", "price_asc", "price_per_m2_asc", "newest"] },
  },
} as const;

export class GeminiError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/**
 * Returns the intent, or throws GeminiError so the caller can fall back to the local parser.
 * A malformed or schema-violating answer counts as a failure: a half-understood filter set is
 * worse than an honest "the model was not used".
 */
async function requestIntent(message: string): Promise<ChatIntent> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: {
          // Same sentence must give the same filters every time - this is a parser, not a writer.
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or a dropped connection says nothing about the request itself - worth one retry.
    throw new GeminiError(error instanceof Error ? error.message : "request failed", true);
  }

  if (!response.ok) {
    // The body carries Google's reason (bad key, quota, unknown model) - useful in the server log,
    // never shown to the user, since it can echo the request back.
    // 429 and 5xx are load, not a bad request: retry those, give up on the rest.
    const retryable = response.status === 429 || response.status >= 500;
    throw new GeminiError(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`, retryable);
  }

  const payload = (await response.json()) as any;
  const text = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text ?? "").join("").trim();
  if (!text) throw new GeminiError("empty response");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GeminiError("response was not valid JSON");
  }

  const parsed = chatIntentSchema.safeParse(raw);
  if (!parsed.success) throw new GeminiError(`response did not match the schema: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/**
 * One retry, and only for load-related failures - the model is popular enough that a 503 or a
 * timeout on the first try is routine. Anything else (bad key, unknown model, schema violation)
 * will fail the same way twice, so it goes straight back to the caller and on to the parser.
 */
export async function parseIntentWithGemini(message: string): Promise<ChatIntent> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await requestIntent(message);
    } catch (error) {
      last = error;
      if (!(error instanceof GeminiError) || !error.retryable || attempt === ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw last;
}
