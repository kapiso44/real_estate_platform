/**
 * What the chat box is allowed to understand.
 *
 * ChatIntent is deliberately *not* OfferFilters. It holds what the user meant, not what the
 * database should be asked - "cheap" stays a flag, never a number. Turning intent into filters
 * is the job of rules.ts, which reads real medians out of the dataset. The model never sees a
 * price and never invents one; if it returns a number here, that number came from the user's
 * own words ("do 600 tys" -> budgetMax 600000).
 */
import { z } from "zod";

/** The canonical feature vocabulary, same list normalize.ts writes into offers.features. */
export const CHAT_FEATURES = [
  "elevator",
  "parking",
  "storage",
  "security",
  "appliances",
  "furnished",
  "balcony",
  "terrace",
  "garden",
  "air_conditioning",
  "separate_kitchen",
  "ready_to_move_in",
  "developer_standard",
  "needs_renovation",
] as const;

export const chatIntentSchema = z.object({
  /** District as the user wrote it; rules.ts matches it against the districts we actually have. */
  district: z.string().trim().min(1).max(100).nullish(),
  /** Total price in PLN, only when the user said a budget out loud. */
  budgetMax: z.number().min(0).max(100_000_000).nullish(),
  budgetMin: z.number().min(0).max(100_000_000).nullish(),
  rooms: z.array(z.number().int().min(1).max(20)).max(10).nullish(),
  /** "around 40m" - an intent, not a threshold. rules.ts widens it into a range. */
  areaAround: z.number().min(5).max(1_000).nullish(),
  areaMin: z.number().min(5).max(1_000).nullish(),
  areaMax: z.number().min(5).max(1_000).nullish(),
  /** "tanie", "cheap", "niedrogie" - resolved against the dataset median, never by the model. */
  cheap: z.boolean().nullish(),
  market: z.enum(["PRIMARY", "SECONDARY"]).nullish(),
  features: z.array(z.enum(CHAT_FEATURES)).max(10).nullish(),
  /** Anything left over worth full-text searching for ("sea view", "nad morzem"). */
  keywords: z.string().trim().max(120).nullish(),
  /**
   * How to order the results. A superlative ("najdroższe", "the cheapest") is an ordering, not a
   * filter - it does not narrow anything down, it just decides what comes first. Keeping it here
   * rather than folding it into `cheap` matters: "najtańsze" must show the cheapest flat in the
   * whole set, not the cheapest among the ones a median cut-off already kept.
   */
  sort: z.enum(["price_desc", "price_asc", "price_per_m2_asc", "newest"]).nullish(),
});

export type ChatIntent = z.infer<typeof chatIntentSchema>;

export const EMPTY_INTENT: ChatIntent = {};

/** True when the model (or the parser) understood nothing actionable. */
export const isEmptyIntent = (intent: ChatIntent): boolean =>
  !Object.values(intent).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== "",
  );

export type IntentSource = "llm" | "fallback";

export interface ParsedIntent {
  intent: ChatIntent;
  source: IntentSource;
  /** Set when the LLM was configured but could not be used, so the UI can be honest about it. */
  degradedReason?: string;
}
