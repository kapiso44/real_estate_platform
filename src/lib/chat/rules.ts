/**
 * Business rules: intent -> filters.
 *
 * This is the half of the chat box that is *not* AI. Everything vague the user said is resolved
 * here, against the real dataset, in code you can read and argue with:
 *
 *   "cheap"        -> price per m2 below the median (of that district, if one was named)
 *   "around 40m"   -> 34-46 m2, because a stated size is an intent, not a threshold
 *   "Wrzeszcz"     -> matched against districts that exist, accent- and case-insensitively
 *
 * Every rule that fires also produces a sentence for the UI, with the number it used, so the
 * user can see what "cheap" was taken to mean and disagree with it.
 */
import { offerFiltersSchema, type OfferFilters } from "@/lib/search";
import type { OffersMeta } from "@/lib/offers";
import { featureLabel, formatPricePerM2 } from "@/lib/format";
import type { ChatIntent } from "@/lib/chat/types";

const SORT_EXPLANATIONS: Record<string, string> = {
  price_desc: "highest price first",
  price_asc: "lowest price first",
  price_per_m2_asc: "best price per m² first",
  newest: "most recently listed first",
};

/** How far "around 40m" reaches in each direction. */
const AREA_TOLERANCE = 0.15;

const plainNumber = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const area = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/** Strips diacritics and case so "wrzeszcz" and "Wrzeszcz" are the same word. */
const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/**
 * Resolves a district name the user typed to the districts we actually have.
 *
 * Returns a list, not one name, because Otodom splits several Gdańsk districts in two:
 * "Przymorze" is stored as Przymorze Wielkie and Przymorze Małe, "Zaspa" as Zaspa-Młyniec and
 * Zaspa-Rozstaje. Someone asking for Przymorze means both, so narrowing to one would silently
 * hide half the listings. Polish inflection ("we Wrzeszczu") is handled by retrying on a
 * truncated stem, the same trick the full-text search uses.
 */
export function matchDistricts(input: string, meta: OffersMeta): string[] {
  const names = meta.districts.map((district) => district.name);
  const attempt = (needle: string): string[] => {
    if (needle.length < 3) return [];
    const exact = names.filter((name) => fold(name) === needle);
    if (exact.length) return exact;
    const prefixed = names.filter((name) => fold(name).startsWith(needle));
    if (prefixed.length) return prefixed;
    return names.filter((name) => fold(name).includes(needle) || needle.includes(fold(name)));
  };

  const needle = fold(input);
  // Full form first, then one and two characters shorter, to absorb a case ending.
  for (const candidate of [needle, needle.slice(0, -1), needle.slice(0, -2)]) {
    const matches = attempt(candidate);
    if (matches.length) return matches;
  }
  return [];
}

export interface AppliedIntent {
  filters: OfferFilters;
  /** One sentence per rule that fired, shown under the chat box. */
  explanations: string[];
  /** Words the user used that we could not act on, so the UI can say so instead of pretending. */
  ignored: string[];
  /** The listing URL that reproduces this search - filters live in the URL, nowhere else. */
  queryString: string;
}

export function applyRules(intent: ChatIntent, meta: OffersMeta): AppliedIntent {
  const draft: Record<string, unknown> = {};
  const explanations: string[] = [];
  const ignored: string[] = [];

  // --- district ------------------------------------------------------------
  let districts: string[] = [];
  if (intent.district) {
    districts = matchDistricts(intent.district, meta);
    if (districts.length) {
      draft.districts = districts;
      explanations.push(`District: ${districts.join(", ")}`);
    } else {
      ignored.push(`we have no listings in “${intent.district}”`);
    }
  }

  // --- budget --------------------------------------------------------------
  if (intent.budgetMax != null) {
    draft.priceMax = intent.budgetMax;
    explanations.push(`Budget: up to ${plainNumber.format(intent.budgetMax)} PLN`);
  }
  if (intent.budgetMin != null) {
    draft.priceMin = intent.budgetMin;
    explanations.push(`At least ${plainNumber.format(intent.budgetMin)} PLN`);
  }

  // --- "cheap" -------------------------------------------------------------
  // The only rule where the user gave no number at all, so the dataset has to supply one.
  // Price per m2 rather than total price: without it "cheap" just means "small".
  if (intent.cheap) {
    // With one district in play its own median is the fair yardstick; across several
    // (or none) fall back to the city-wide one rather than picking a winner.
    const districtMedian =
      districts.length === 1
        ? (meta.districts.find((entry) => entry.name === districts[0])?.medianPricePerM2 ?? null)
        : null;
    const median = districtMedian ?? meta.medianPricePerM2;
    if (median != null) {
      draft.pricePerM2Max = median;
      explanations.push(
        districtMedian != null
          ? `“Cheap” = below the ${districts[0]} median of ${formatPricePerM2(median)}`
          : `“Cheap” = below the city-wide median of ${formatPricePerM2(median)}`,
      );
    } else {
      ignored.push("“cheap” - not enough price data to work out a median");
    }
  }

  // --- rooms ---------------------------------------------------------------
  if (intent.rooms?.length) {
    const rooms = [...new Set(intent.rooms)].sort((a, b) => a - b);
    draft.rooms = rooms;
    explanations.push(`Rooms: ${rooms.join(" or ")}`);
  }

  // --- area ----------------------------------------------------------------
  // A stated size is what the user has in mind, not a hard edge: 40 m2 should not hide a 41 m2
  // flat. An explicit min/max ("at least 50 m2") is taken literally instead.
  if (intent.areaAround != null && intent.areaMin == null && intent.areaMax == null) {
    const min = Math.round(intent.areaAround * (1 - AREA_TOLERANCE) * 10) / 10;
    const max = Math.round(intent.areaAround * (1 + AREA_TOLERANCE) * 10) / 10;
    draft.areaMin = min;
    draft.areaMax = max;
    explanations.push(
      `Around ${area.format(intent.areaAround)} m² = ${area.format(min)}-${area.format(max)} m² (±${Math.round(AREA_TOLERANCE * 100)}%)`,
    );
  } else {
    if (intent.areaMin != null) {
      draft.areaMin = intent.areaMin;
      explanations.push(`At least ${area.format(intent.areaMin)} m²`);
    }
    if (intent.areaMax != null) {
      draft.areaMax = intent.areaMax;
      explanations.push(`At most ${area.format(intent.areaMax)} m²`);
    }
  }

  // --- market --------------------------------------------------------------
  if (intent.market) {
    draft.market = intent.market;
    explanations.push(intent.market === "PRIMARY" ? "New build only" : "Resale only");
  }

  // --- features ------------------------------------------------------------
  if (intent.features?.length) {
    const features = [...new Set(intent.features)];
    draft.features = features;
    explanations.push(`Must have: ${features.map(featureLabel).join(", ")}`);
  }

  // --- leftover words ------------------------------------------------------
  // Anything we have no column for goes to full-text search rather than being dropped.
  if (intent.keywords) {
    draft.q = intent.keywords;
    explanations.push(`Text search: “${intent.keywords}”`);
  }

  // --- ordering ------------------------------------------------------------
  // An explicit superlative outranks the relevance ordering a text search would default to:
  // "najtańsze mieszkanie z balkonem" asks for cheapest first, not best-matching first.
  if (intent.sort) {
    draft.sort = intent.sort;
    explanations.push(`Sorted by: ${SORT_EXPLANATIONS[intent.sort]}`);
  } else if (intent.keywords) {
    draft.sort = "relevance";
  }

  // The schema is the gate: nothing reaches searchOffers that a hand-typed URL could not.
  const filters = offerFiltersSchema.parse(draft);
  return { filters, explanations, ignored, queryString: toQueryString(filters) };
}

/** Serialises filters back into the listing URL, skipping values that are already the default. */
export function toQueryString(filters: OfferFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  for (const district of filters.districts ?? []) params.append("districts", district);
  for (const room of filters.rooms ?? []) params.append("rooms", String(room));
  for (const feature of filters.features ?? []) params.append("features", feature);
  const numbers: [string, number | undefined][] = [
    ["priceMin", filters.priceMin],
    ["priceMax", filters.priceMax],
    ["areaMin", filters.areaMin],
    ["areaMax", filters.areaMax],
    ["pricePerM2Max", filters.pricePerM2Max],
  ];
  for (const [key, value] of numbers) if (value != null) params.set(key, String(value));
  if (filters.market) params.set("market", filters.market);
  if (filters.sort !== "relevance") params.set("sort", filters.sort);
  return params.toString();
}
