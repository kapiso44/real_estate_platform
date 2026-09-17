/**
 * Stage 1f: offers_raw -> offers.
 *
 * Pure function of the raw table: no network, no API key, idempotent. Every questionable
 * value is kept but flagged rather than silently repaired, and every value that did not come
 * from the primary source (the search listing) is recorded in field_sources.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { chunk, connect, schema } from "./_db.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Output of the one-off enrichment pass (stage 2). Absent file = normalization without AI. */
const AI_FILE = join(ROOT, "data", "enriched", "otodom-ai.json");

// --- raw record shape (subset we read) -------------------------------------------------

interface RawOffer {
  id: number;
  offerUrl: string;
  title: string;
  transaction: string | null;
  price: number | null;
  currency: string | null;
  pricePerSqm: number | null;
  rent: number | null;
  area: number | null;
  rooms: string | null;
  floor: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  streetSource: "list" | "detail" | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  allImages: string[];
  totalPossibleImages: number | null;
  market: string | null;
  buildYear: number | null;
  buildingFloorsNum: number | null;
  buildingType: string | null;
  buildingMaterial: string | null;
  buildingOwnership: string | null;
  constructionStatus: string | null;
  heating: string | null;
  windowsType: string | null;
  equipmentTypes: string[];
  extrasTypes: string[];
  securityTypes: string[];
  sellerName: string | null;
  sellerType: string | null;
  isPromoted: boolean;
  isPrivateOwner: boolean;
  dateCreated: string | null;
  modifiedAt: string | null;
}

// --- value mappers ---------------------------------------------------------------------

const ROOMS_ENUM: Record<string, number> = {
  ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10,
};

const FLOOR_ENUM: Record<string, number> = {
  GROUND: 0, FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5,
  SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10,
};

/** Floors that exist but have no single number: kept as a label so the UI can still show them. */
const FLOOR_LABELS: Record<string, string> = {
  ABOVE_TENTH: "above_tenth",
  GARRET: "garret",
  CELLAR: "cellar",
};

/**
 * Otodom's raw amenity slugs and the AI vocabulary describe the same things under different
 * names: "lift" and "elevator" appear together on 20 offers, "garage" and "parking" on 29,
 * and a storage room arrives as "storage", "basement" or "usable_room". Filtering on the raw
 * slugs would show the user two checkboxes that mean one thing, so everything is folded into
 * one canonical vocabulary here - the database, the API, the UI and the chat all speak it.
 *
 * Raw slugs stay untouched in offers_raw, so this map can change without re-scraping.
 * Slugs left out on purpose (too niche to filter on): tv, roller_shutters, media types.
 */
const FEATURE_CANONICAL: Record<string, string> = {
  lift: "elevator", elevator: "elevator",
  garage: "parking", parking: "parking",
  storage: "storage", basement: "storage", usable_room: "storage",
  entryphone: "security", anti_burglary_door: "security", monitoring: "security",
  alarm: "security", closed_area: "security",
  stove: "appliances", oven: "appliances", fridge: "appliances",
  dishwasher: "appliances", washing_machine: "appliances",
  furniture: "furnished",
  balcony: "balcony", terrace: "terrace", garden: "garden",
  air_conditioning: "air_conditioning", separate_kitchen: "separate_kitchen",
  ready_to_move_in: "ready_to_move_in", developer_standard: "developer_standard",
  needs_renovation: "needs_renovation",
};

const toCanonicalFeatures = (slugs: string[]): string[] =>
  [...new Set(slugs.map((slug) => FEATURE_CANONICAL[slug.toLowerCase()]).filter(Boolean))].sort();

const RANGES = {
  area: [10, 500],
  price: [50_000, 50_000_000],
  pricePerM2: [1_000, 100_000],
  year: [1800, new Date().getFullYear() + 5],
  floors: [0, 50],
  rent: [1, 10_000],
} as const;

const inRange = (value: number, [min, max]: readonly [number, number]) => value >= min && value <= max;

/** Naive "YYYY-MM-DD HH:mm:ss" timestamps from the listing are read as UTC (documented limitation). */
function toDate(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function roomsFromTitle(title: string): number | null {
  if (/kawalerk/i.test(title)) return 1;
  const digits = title.match(/(\d+)\s*[-\s]?\s*pok/i);
  if (digits) return Number(digits[1]);
  const words: Record<string, number> = { jedno: 1, dwu: 2, trzy: 3, cztero: 4, pięcio: 5, piecio: 5 };
  const word = title.match(/(jedno|dwu|trzy|cztero|pięcio|piecio)pokoj/i);
  return word ? words[word[1].toLowerCase()] ?? null : null;
}

/** Metres between two WGS84 points (haversine), used for duplicate detection. */
function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// --- normalization ---------------------------------------------------------------------

interface Normalized {
  row: typeof schema.offers.$inferInsert;
  raw: RawOffer;
}

function normalizeOne(raw: RawOffer): Normalized {
  const flags: string[] = [];
  const sources: Record<string, { source: string; quote?: string }> = {};

  const num = (value: number | null, range: readonly [number, number], field: string) => {
    if (value == null) return null;
    if (!inRange(value, range)) {
      flags.push(`${field}_out_of_range`);
      return null;
    }
    return value;
  };

  // rooms: the structured field wins over the title, but a conflict is recorded
  let rooms: number | null = null;
  if (raw.rooms) {
    rooms = ROOMS_ENUM[raw.rooms] ?? null;
    if (rooms == null) flags.push("rooms_unmapped");
  }
  const titleRooms = roomsFromTitle(raw.title);
  if (rooms != null && titleRooms != null && titleRooms !== rooms) flags.push("rooms_title_mismatch");

  // floor: a label instead of a made-up number when the source is not precise
  let floorNum: number | null = null;
  let floorLabel: string | null = null;
  if (raw.floor) {
    if (raw.floor in FLOOR_ENUM) {
      floorNum = FLOOR_ENUM[raw.floor];
      floorLabel = raw.floor.toLowerCase();
    } else if (raw.floor in FLOOR_LABELS) {
      floorLabel = FLOOR_LABELS[raw.floor];
      flags.push("floor_not_numeric");
    } else {
      flags.push("floor_unmapped");
    }
  }
  const floorsTotal = num(raw.buildingFloorsNum, RANGES.floors, "floors_total");
  if (floorNum != null && floorsTotal != null && floorNum > floorsTotal) {
    flags.push("floor_above_building_height");
    floorNum = null;
  }

  // street: "420" is a house number that landed in the street name field
  let street = raw.street;
  if (street && /^[\d\W]+$/.test(street)) {
    flags.push("street_not_a_name");
    street = null;
  }
  if (street && raw.streetSource === "detail") sources.street = { source: "detail_page" };

  const description = raw.description?.trim() || null;
  if (!description) flags.push("description_missing");
  if (description && /<[a-z/][^>]*>/i.test(description)) flags.push("description_has_html");

  const photos = raw.allImages ?? [];
  if (photos.length === 0) flags.push("photos_missing");
  if (raw.totalPossibleImages != null && photos.length > raw.totalPossibleImages) {
    flags.push("photos_more_than_declared");
  }

  if (raw.latitude == null || raw.longitude == null) flags.push("coordinates_missing");
  if (raw.buildYear == null) flags.push("year_built_missing");
  if (!street) flags.push("street_missing");
  if (floorNum == null && floorLabel == null) flags.push("floor_missing");

  // A rent of 0 means "not stated", not "free".
  const rent = raw.rent != null && raw.rent > 0 ? num(raw.rent, RANGES.rent, "rent") : null;

  const features = toCanonicalFeatures([
    ...(raw.extrasTypes ?? []),
    ...(raw.equipmentTypes ?? []),
    ...(raw.securityTypes ?? []),
  ]);

  return {
    raw,
    row: {
      id: raw.id,
      sourceUrl: raw.offerUrl,
      transactionType: raw.transaction ?? "SELL",
      title: raw.title,
      descriptionClean: description,
      descriptionHash: description ? createHash("sha256").update(description).digest("hex") : null,
      price: num(raw.price, RANGES.price, "price")?.toFixed(2) ?? null,
      currency: raw.currency,
      pricePerM2: num(raw.pricePerSqm, RANGES.pricePerM2, "price_per_m2")?.toFixed(2) ?? null,
      rent: rent?.toFixed(2) ?? null,
      areaM2: num(raw.area, RANGES.area, "area")?.toFixed(2) ?? null,
      rooms,
      floorNum,
      floorLabel,
      floorsTotal,
      yearBuilt: num(raw.buildYear, RANGES.year, "year_built"),
      market: raw.market,
      advertiserType: raw.isPrivateOwner ? "PRIVATE" : (raw.sellerType ?? null),
      sellerName: raw.sellerName,
      city: raw.city ?? "Gdańsk",
      district: raw.district,
      street,
      lat: raw.latitude?.toFixed(6) ?? null,
      lng: raw.longitude?.toFixed(6) ?? null,
      buildingType: raw.buildingType,
      buildingMaterial: raw.buildingMaterial,
      buildingOwnership: raw.buildingOwnership,
      constructionStatus: raw.constructionStatus,
      heating: raw.heating,
      windowsType: raw.windowsType,
      photos,
      photosCount: photos.length,
      photosDeclared: raw.totalPossibleImages,
      features,
      priceNotes: [],
      qualityFlags: flags,
      fieldSources: sources,
      duplicateGroupId: null,
      isCanonical: true,
      aiSummary: null,
      isPromoted: Boolean(raw.isPromoted),
      publishedAt: toDate(raw.dateCreated),
      modifiedAt: toDate(raw.modifiedAt),
    },
  };
}

/** Marks descriptions reused across offers (developer templates). */
function flagTemplateDescriptions(items: Normalized[]): void {
  const byHash = new Map<string, number>();
  for (const { row } of items) {
    if (row.descriptionHash) byHash.set(row.descriptionHash, (byHash.get(row.descriptionHash) ?? 0) + 1);
  }
  for (const { row } of items) {
    if (row.descriptionHash && (byHash.get(row.descriptionHash) ?? 0) > 1) {
      (row.qualityFlags as string[]).push("template_description");
    }
  }
}

/**
 * Groups offers that look like the same flat listed twice: same room count and floor,
 * area within 0.5%, price within 1%, coordinates within 50 m. Different floor means a
 * different flat, so it never groups those. Duplicates are grouped, never deleted.
 */
function groupDuplicates(items: Normalized[]): void {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    const up = parent.get(id) ?? id;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };

  const close = (a: number | null, b: number | null, tolerance: number) =>
    a != null && b != null && Math.abs(a - b) <= Math.max(a, b) * tolerance;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].row;
      const b = items[j].row;
      if (a.rooms !== b.rooms) continue;
      if (a.floorNum !== b.floorNum || a.floorLabel !== b.floorLabel) continue;
      if (!close(Number(a.areaM2), Number(b.areaM2), 0.005)) continue;
      if (!close(Number(a.price), Number(b.price), 0.01)) continue;
      if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
      if (distanceMeters(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng)) > 50) continue;
      union(a.id!, b.id!);
    }
  }

  const groups = new Map<number, Normalized[]>();
  for (const item of items) {
    const root = find(item.row.id!);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  }

  // Completeness score decides which offer represents the group; ties go to the lower id.
  const completeness = (item: Normalized) =>
    Object.values(item.row).filter((value) => value != null && value !== "").length +
    (item.row.photosCount ?? 0) -
    (item.row.qualityFlags as string[]).length;

  for (const [root, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => completeness(b) - completeness(a) || a.row.id! - b.row.id!);
    for (const [index, item] of sorted.entries()) {
      item.row.duplicateGroupId = `dup-${root}`;
      item.row.isCanonical = index === 0;
      if (index > 0) (item.row.qualityFlags as string[]).push("duplicate_of_canonical");
    }
  }
}

interface AiEntry {
  summary?: string;
  features?: { feature: string; quote: string }[];
  priceNotes?: { type: string; amountPln?: number; quote: string }[];
  floor?: { value: number; quote: string };
  yearBuilt?: { value: number; quote: string };
}

function loadEnrichment(): Record<string, AiEntry> {
  if (!existsSync(AI_FILE)) return {};
  return JSON.parse(readFileSync(AI_FILE, "utf8")).offers ?? {};
}

/**
 * Merges the validated enrichment into the rows. Runs AFTER duplicate grouping on purpose:
 * duplicates are decided on source data only, so an AI-inferred floor cannot split a pair.
 * AI never overwrites a value the source provided - it only fills holes, and every filled
 * hole records its source and the quote that justifies it.
 */
function applyEnrichment(items: Normalized[], enrichment: Record<string, AiEntry>): Record<string, number> {
  const stats = { offers: 0, summaries: 0, priceNotes: 0, features: 0, floors: 0, years: 0 };
  for (const { row } of items) {
    const entry = enrichment[String(row.id)];
    if (!entry) continue;
    stats.offers++;

    if (entry.summary) {
      row.aiSummary = entry.summary;
      stats.summaries++;
    }
    if (entry.priceNotes?.length) {
      row.priceNotes = entry.priceNotes;
      stats.priceNotes++;
    }
    if (entry.features?.length) {
      const structural = row.features as string[];
      const added = toCanonicalFeatures(entry.features.map((f) => f.feature)).filter((f) => !structural.includes(f));
      if (added.length) {
        row.features = [...structural, ...added].sort();
        (row.fieldSources as Record<string, unknown>).features = {
          source: "ai_description",
          quote: entry.features.find((f) => added.includes(f.feature))!.quote,
        };
        stats.features++;
      }
    }
    if (entry.floor && row.floorNum == null && row.floorLabel == null) {
      row.floorNum = entry.floor.value;
      (row.fieldSources as Record<string, unknown>).floor = { source: "ai_description", quote: entry.floor.quote };
      row.qualityFlags = (row.qualityFlags as string[]).filter((flag) => flag !== "floor_missing");
      stats.floors++;
    }
    if (entry.yearBuilt && row.yearBuilt == null) {
      row.yearBuilt = entry.yearBuilt.value;
      (row.fieldSources as Record<string, unknown>).year_built = { source: "ai_description", quote: entry.yearBuilt.quote };
      row.qualityFlags = (row.qualityFlags as string[]).filter((flag) => flag !== "year_built_missing");
      stats.years++;
    }
  }
  return stats;
}

async function main() {
  const { db, pool } = connect();
  try {
    const [rawRows] = await pool.query<any[]>("SELECT id, payload FROM offers_raw ORDER BY id");
    if (rawRows.length === 0) throw new Error("offers_raw is empty — run `npm run db:import-raw` first");

    const items = rawRows.map((row) => {
      const payload: RawOffer = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      return normalizeOne(payload);
    });

    flagTemplateDescriptions(items);
    groupDuplicates(items);

    const enrichment = loadEnrichment();
    const aiStats = applyEnrichment(items, enrichment);

    const columns = Object.keys(items[0].row) as (keyof typeof schema.offers.$inferInsert)[];
    const updateSet = Object.fromEntries(
      columns
        .filter((column) => column !== "id")
        .map((column) => [column, sql.raw(`VALUES(\`${(schema.offers as any)[column].name}\`)`)]),
    );

    for (const batch of chunk(items.map((item) => item.row), 20)) {
      await db.insert(schema.offers).values(batch).onDuplicateKeyUpdate({ set: updateSet as any });
    }

    const groups = new Set(items.map((item) => item.row.duplicateGroupId).filter(Boolean));
    console.log(`normalized ${items.length} offers`);
    console.log(`duplicate groups: ${groups.size}`);
    console.log(
      Object.keys(enrichment).length
        ? `ai enrichment: ${aiStats.offers} offers (summaries ${aiStats.summaries}, price notes ${aiStats.priceNotes}, features ${aiStats.features}, floor ${aiStats.floors}, year ${aiStats.years})`
        : "ai enrichment: no data/enriched/otodom-ai.json — normalized without AI",
    );
    console.log(`offers with at least one quality flag: ${items.filter((i) => (i.row.qualityFlags as string[]).length > 0).length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
