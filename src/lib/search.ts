/**
 * The single place that knows how to search offers.
 *
 * The listing page, /api/offers and (later) the chat box all go through searchOffers,
 * so there is exactly one definition of what a filter means. The chat box's only job will
 * be to produce an OfferFilters object - it never builds SQL and never sees the database.
 */
import { z } from "zod";
import { pool } from "@/lib/db";

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const SORT_OPTIONS = ["relevance", "price_asc", "price_desc", "price_per_m2_asc", "newest"] as const;

export const offerFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  districts: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  priceMin: z.coerce.number().min(0).max(100_000_000).optional(),
  priceMax: z.coerce.number().min(0).max(100_000_000).optional(),
  areaMin: z.coerce.number().min(0).max(10_000).optional(),
  areaMax: z.coerce.number().min(0).max(10_000).optional(),
  pricePerM2Max: z.coerce.number().min(0).max(1_000_000).optional(),
  rooms: z.array(z.coerce.number().int().min(1).max(20)).max(10).optional(),
  market: z.enum(["PRIMARY", "SECONDARY"]).optional(),
  features: z.array(z.string().trim().min(1).max(40)).max(15).optional(),
  sort: z.enum(SORT_OPTIONS).default("relevance"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** Hidden copies of the same flat are excluded unless explicitly asked for. */
  includeDuplicates: z.coerce.boolean().default(false),
});

export type OfferFilters = z.infer<typeof offerFiltersSchema>;

/** Reads filters out of a URL query string, accepting both `rooms=2&rooms=3` and `rooms=2,3`. */
export function parseFilters(params: URLSearchParams): OfferFilters {
  const list = (key: string) => {
    const values = params.getAll(key).flatMap((value) => value.split(","));
    const cleaned = values.map((value) => value.trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  };
  const single = (key: string) => params.get(key)?.trim() || undefined;

  return offerFiltersSchema.parse({
    q: single("q"),
    districts: list("districts"),
    priceMin: single("priceMin"),
    priceMax: single("priceMax"),
    areaMin: single("areaMin"),
    areaMax: single("areaMax"),
    pricePerM2Max: single("pricePerM2Max"),
    rooms: list("rooms"),
    market: single("market"),
    features: list("features"),
    sort: single("sort") ?? undefined,
    page: single("page"),
    pageSize: single("pageSize"),
    includeDuplicates: single("includeDuplicates"),
  });
}

// ---------------------------------------------------------------------------
// Full-text handling
// ---------------------------------------------------------------------------

/** MySQL's default InnoDB full-text minimum token length; shorter words are not indexed. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Crude suffix stripping in place of a Polish stemmer, which MySQL does not have.
 *
 * Polish inflects by suffix, so every grammatical case lands in its own full-text token.
 * A prefix wildcard alone only extends to the right, so the inflected form a user types
 * still fails to find the base form. Truncating the token first makes it work in both
 * directions. Measured on this dataset (offers matched):
 *
 *   "Wrzeszczu"  3 -> 21    "balkonem"  7 -> 61    "kawalerki" 1 -> 8
 *   "Przymorzu"  2 ->  4    "tarasem"   2 ->  7    "windą"     9 -> 27
 *
 * The tradeoff is deliberate over-matching on short stems; ranking by relevance keeps the
 * best hits on top. Diacritics need no handling - the utf8mb4_0900_ai_ci collation already
 * treats "garaz" and "garaż" as the same token.
 */
function stemToken(token: string): string {
  if (token.length >= 6) return token.slice(0, -2);
  if (token.length >= 4) return token.slice(0, -1);
  return token;
}

export interface TextQuery {
  /** Every term required - precise, but one absent word empties the result. */
  strict: string;
  /** Any term matches, ranked by relevance - the fallback when strict finds nothing. */
  relaxed: string;
}

/** Returns null when nothing indexable is left, so the caller can fall back to LIKE. */
export function toBooleanQuery(phrase: string): TextQuery | null {
  const stems = phrase
    .split(/[^\p{L}\p{N}]+/u)
    // + and * are the operators we add ourselves; anything else operator-like is stripped
    .map((token) => token.trim().replace(/[+\-<>()~*"@]/g, ""))
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .map(stemToken)
    .filter((stem) => stem.length >= MIN_TOKEN_LENGTH);
  if (!stems.length) return null;
  return {
    strict: stems.map((stem) => `+${stem}*`).join(" "),
    relaxed: stems.map((stem) => `${stem}*`).join(" "),
  };
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

interface WhereClause { sql: string; params: unknown[] }

function buildWhere(filters: OfferFilters, textMode: keyof TextQuery = "strict"): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!filters.includeDuplicates) clauses.push("o.is_canonical = 1");

  if (filters.q) {
    const booleanQuery = toBooleanQuery(filters.q);
    if (booleanQuery) {
      // District names are matched separately: they live in their own column and are not
      // part of the full-text index.
      clauses.push(`(MATCH(o.title, o.description_clean, o.ai_summary) AGAINST (? IN BOOLEAN MODE) OR o.district LIKE ?)`);
      params.push(booleanQuery[textMode], `%${filters.q}%`);
    } else {
      clauses.push("(o.title LIKE ? OR o.district LIKE ?)");
      params.push(`%${filters.q}%`, `%${filters.q}%`);
    }
  }

  if (filters.districts?.length) {
    clauses.push(`o.district IN (${filters.districts.map(() => "?").join(", ")})`);
    params.push(...filters.districts);
  }
  if (filters.rooms?.length) {
    clauses.push(`o.rooms IN (${filters.rooms.map(() => "?").join(", ")})`);
    params.push(...filters.rooms);
  }
  // A row with NULL in a filtered column drops out: we never guess what a missing value means.
  if (filters.priceMin != null) { clauses.push("o.price >= ?"); params.push(filters.priceMin); }
  if (filters.priceMax != null) { clauses.push("o.price <= ?"); params.push(filters.priceMax); }
  if (filters.areaMin != null) { clauses.push("o.area_m2 >= ?"); params.push(filters.areaMin); }
  if (filters.areaMax != null) { clauses.push("o.area_m2 <= ?"); params.push(filters.areaMax); }
  if (filters.pricePerM2Max != null) { clauses.push("o.price_per_m2 <= ?"); params.push(filters.pricePerM2Max); }
  if (filters.market) { clauses.push("o.market = ?"); params.push(filters.market); }

  for (const feature of filters.features ?? []) {
    clauses.push("JSON_CONTAINS(o.features, JSON_QUOTE(?))");
    params.push(feature);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function buildOrderBy(filters: OfferFilters, hasRelevance: boolean): string {
  switch (filters.sort) {
    case "price_asc": return "ORDER BY o.price IS NULL, o.price ASC, o.id DESC";
    case "price_desc": return "ORDER BY o.price IS NULL, o.price DESC, o.id DESC";
    case "price_per_m2_asc": return "ORDER BY o.price_per_m2 IS NULL, o.price_per_m2 ASC, o.id DESC";
    case "newest": return "ORDER BY o.published_at IS NULL, o.published_at DESC, o.id DESC";
    default:
      // "relevance" only means something with a text query; otherwise fall back to newest.
      return hasRelevance ? "ORDER BY relevance DESC, o.id DESC" : "ORDER BY o.published_at IS NULL, o.published_at DESC, o.id DESC";
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface OfferListItem {
  id: number;
  title: string;
  sourceUrl: string;
  price: number | null;
  pricePerM2: number | null;
  areaM2: number | null;
  rooms: number | null;
  floorNum: number | null;
  floorLabel: string | null;
  district: string | null;
  street: string | null;
  market: string | null;
  yearBuilt: number | null;
  photo: string | null;
  photosCount: number;
  features: string[];
  aiSummary: string | null;
  priceNotes: { type: string; amountPln?: number; quote: string }[];
  qualityFlags: string[];
  isPromoted: boolean;
  publishedAt: string | null;
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export function toListItem(row: any): OfferListItem {
  const photos = asArray<string>(row.photos);
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    price: row.price ?? null,
    pricePerM2: row.price_per_m2 ?? null,
    areaM2: row.area_m2 ?? null,
    rooms: row.rooms ?? null,
    floorNum: row.floor_num ?? null,
    floorLabel: row.floor_label ?? null,
    district: row.district ?? null,
    street: row.street ?? null,
    market: row.market ?? null,
    yearBuilt: row.year_built ?? null,
    photo: photos[0] ?? null,
    photosCount: row.photos_count ?? photos.length,
    features: asArray<string>(row.features),
    aiSummary: row.ai_summary ?? null,
    priceNotes: asArray(row.price_notes),
    qualityFlags: asArray<string>(row.quality_flags),
    isPromoted: Boolean(row.is_promoted),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}

export interface SearchResult {
  items: OfferListItem[];
  total: number;
  page: number;
  pageSize: number;
  appliedFilters: OfferFilters;
  /** True when requiring every search word returned nothing and any-word matching was used instead. */
  textQueryRelaxed?: boolean;
}

// ---------------------------------------------------------------------------

async function countMatching(where: WhereClause): Promise<number> {
  const [rows] = await pool.query<any[]>(`SELECT COUNT(*) AS total FROM offers o ${where.sql}`, where.params);
  return Number(rows[0]?.total ?? 0);
}

export async function searchOffers(filters: OfferFilters): Promise<SearchResult> {
  const booleanQuery = filters.q ? toBooleanQuery(filters.q) : null;

  // Requiring every word is precise but brittle: one word absent from the corpus
  // ("tanie mieszkanie Wrzeszcz") empties the result. Relax to any-word matching rather
  // than showing nothing, and say so in the response so the UI can tell the user.
  let textMode: keyof TextQuery = "strict";
  let where = buildWhere(filters, textMode);
  let total = await countMatching(where);
  if (total === 0 && booleanQuery) {
    textMode = "relaxed";
    where = buildWhere(filters, textMode);
    total = await countMatching(where);
  }

  const relevanceSelect = booleanQuery
    ? "MATCH(o.title, o.description_clean, o.ai_summary) AGAINST (? IN BOOLEAN MODE) AS relevance"
    : "0 AS relevance";
  const relevanceParams = booleanQuery ? [booleanQuery[textMode]] : [];

  const offset = (filters.page - 1) * filters.pageSize;
  const [rows] = await pool.query<any[]>(
    `SELECT o.id, o.title, o.source_url, o.price, o.price_per_m2, o.area_m2, o.rooms,
            o.floor_num, o.floor_label, o.district, o.street, o.market, o.year_built,
            o.photos, o.photos_count, o.features, o.ai_summary, o.price_notes,
            o.quality_flags, o.is_promoted, o.published_at,
            ${relevanceSelect}
     FROM offers o
     ${where.sql}
     ${buildOrderBy(filters, Boolean(booleanQuery))}
     LIMIT ? OFFSET ?`,
    [...relevanceParams, ...where.params, filters.pageSize, offset],
  );

  return {
    items: rows.map(toListItem),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    appliedFilters: filters,
    ...(textMode === "relaxed" ? { textQueryRelaxed: true } : {}),
  };
}
