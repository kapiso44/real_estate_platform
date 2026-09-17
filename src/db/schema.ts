import {
  bigint,
  boolean,
  char,
  decimal,
  index,
  json,
  mediumtext,
  mysqlTable,
  smallint,
  timestamp,
  tinyint,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Layer 1: the scraped record, stored exactly as it came out of the scraper.
 * Normalization can be re-run from here without touching the network.
 */
export const offersRaw = mysqlTable("offers_raw", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  source: varchar("source", { length: 16 }).notNull().default("otodom"),
  sourceUrl: varchar("source_url", { length: 512 }).notNull(),
  payload: json("payload").notNull(),
  fetchedAt: timestamp("fetched_at").notNull(),
  importedAt: timestamp("imported_at").notNull().defaultNow().onUpdateNow(),
});

/**
 * Layer 2: normalized offers, the only table the app reads.
 *
 * Conventions:
 * - a missing value is always NULL, never 0 or an empty string;
 * - every value that was not taken verbatim from the primary source is recorded in fieldSources;
 * - anything suspicious is kept but flagged in qualityFlags instead of being silently fixed.
 */
export const offers = mysqlTable(
  "offers",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    sourceUrl: varchar("source_url", { length: 512 }).notNull(),
    // Constant "SELL" for this dataset; kept explicit so a rental import cannot slip in unnoticed.
    transactionType: varchar("transaction_type", { length: 8 }).notNull(),

    title: varchar("title", { length: 300 }).notNull(),
    descriptionClean: mediumtext("description_clean"),
    descriptionHash: char("description_hash", { length: 64 }),

    price: decimal("price", { precision: 12, scale: 2 }),
    currency: char("currency", { length: 3 }),
    pricePerM2: decimal("price_per_m2", { precision: 10, scale: 2 }),
    /** Monthly administrative fee ("czynsz"), not a rental price. */
    rent: decimal("rent", { precision: 8, scale: 2 }),

    areaM2: decimal("area_m2", { precision: 6, scale: 2 }),
    rooms: tinyint("rooms"),
    /** NULL when the source only says "above tenth" - see floorLabel. */
    floorNum: tinyint("floor_num"),
    floorLabel: varchar("floor_label", { length: 24 }),
    floorsTotal: tinyint("floors_total"),
    yearBuilt: smallint("year_built"),

    market: varchar("market", { length: 16 }),
    advertiserType: varchar("advertiser_type", { length: 16 }),
    /** Agency name only; private sellers are natural persons and stay anonymous. */
    sellerName: varchar("seller_name", { length: 200 }),

    city: varchar("city", { length: 100 }).notNull(),
    district: varchar("district", { length: 100 }),
    street: varchar("street", { length: 200 }),
    lat: decimal("lat", { precision: 9, scale: 6 }),
    lng: decimal("lng", { precision: 9, scale: 6 }),

    buildingType: varchar("building_type", { length: 40 }),
    buildingMaterial: varchar("building_material", { length: 40 }),
    buildingOwnership: varchar("building_ownership", { length: 40 }),
    constructionStatus: varchar("construction_status", { length: 40 }),
    heating: varchar("heating", { length: 40 }),
    windowsType: varchar("windows_type", { length: 40 }),

    photos: json("photos").$type<string[]>().notNull(),
    photosCount: smallint("photos_count").notNull(),
    photosDeclared: smallint("photos_declared"),

    /** Normalized amenity slugs merged from extras/equipment/security lists. */
    features: json("features").$type<string[]>().notNull(),
    /** Filled in stage 2 (offline AI pass): mandatory extra costs, VAT notes, each with a quote. */
    priceNotes: json("price_notes").$type<{ type: string; amountPln?: number; quote: string }[]>().notNull(),
    qualityFlags: json("quality_flags").$type<string[]>().notNull(),
    /**
     * field name -> provenance of a value that did not come from the primary source,
     * e.g. { street: { source: "detail_page" }, floor: { source: "ai_description", quote: "..." } }.
     */
    fieldSources: json("field_sources").$type<Record<string, { source: string; quote?: string }>>().notNull(),

    duplicateGroupId: varchar("duplicate_group_id", { length: 64 }),
    isCanonical: boolean("is_canonical").notNull().default(true),

    /** Filled in stage 2; NULL means "no AI summary yet". */
    aiSummary: mediumtext("ai_summary"),

    isPromoted: boolean("is_promoted").notNull().default(false),
    publishedAt: timestamp("published_at"),
    modifiedAt: timestamp("modified_at"),
    normalizedAt: timestamp("normalized_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    index("idx_offers_price").on(t.price),
    index("idx_offers_area").on(t.areaM2),
    index("idx_offers_price_per_m2").on(t.pricePerM2),
    index("idx_offers_district").on(t.district),
    index("idx_offers_rooms").on(t.rooms),
    index("idx_offers_market").on(t.market),
    index("idx_offers_canonical").on(t.isCanonical),
    index("idx_offers_duplicate_group").on(t.duplicateGroupId),
  ],
);

export type OfferRow = typeof offers.$inferSelect;
export type NewOfferRow = typeof offers.$inferInsert;
