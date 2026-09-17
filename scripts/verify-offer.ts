/**
 * Manual verification helper: prints one offer side by side - the normalized database row,
 * the raw scraped value it came from, and the link to the live Otodom page.
 *
 *   npm run verify                 # a preselected set of interesting offers
 *   npm run verify 68416919 12345  # specific ids
 *
 * Differences are expected wherever normalization deliberately changed something
 * (0 rent -> NULL, invalid street -> NULL, enum -> number); those rows are marked.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./_db.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Offers worth eyeballing: each one exercises a different normalization rule. */
const DEFAULT_IDS = [
  68416919, // title says "3 pokoje", structured field says 2 -> flagged conflict
  68419629, // street is literally "420" -> dropped as not a name
  68417903, // phone number redacted from the description, floor above tenth
  68416387, 68416389, // duplicate pair: identical price, area and coordinates
  68419442, 68416668, // near-duplicate pair: 716 780 vs 716 809 zl
];

const show = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return value.length ? `[${value.length}] ${value.slice(0, 3).join(", ")}${value.length > 3 ? " ..." : ""}` : "[]";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
};

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);
  const wanted = ids.length ? ids : DEFAULT_IDS;

  const raw = JSON.parse(readFileSync(join(ROOT, "data/raw/otodom-offers.json"), "utf8"));
  const byId = new Map<number, any>(raw.map((offer: any) => [offer.id, offer]));

  const { pool } = connect();
  try {
    const [rows] = await pool.query<any[]>("SELECT * FROM offers WHERE id IN (?)", [wanted]);
    const dbById = new Map(rows.map((row) => [row.id, row]));

    for (const id of wanted) {
      const db = dbById.get(id);
      const src = byId.get(id);
      if (!db || !src) {
        console.log(`\n### ${id} — ${!db ? "brak w bazie" : "brak w pliku"}\n`);
        continue;
      }

      console.log(`\n${"=".repeat(96)}`);
      console.log(`### ${id}  ${db.title}`);
      console.log(`### ${db.source_url}`);
      console.log("=".repeat(96));

      // A value filled from the description (by the AI pass) or from the offer page is an
      // intended difference from data/raw, not an error - label it with where it came from.
      const provenance = (field: string): string | undefined => {
        const entry = db.field_sources?.[field];
        if (!entry) return undefined;
        return entry.source === "ai_description"
          ? "uzupelnione z opisu przez AI, z cytatem"
          : `zrodlo: ${entry.source}`;
      };

      // [database column, raw field, note when a difference is intended]
      const pairs: [string, unknown, unknown, string?][] = [
        ["price", db.price, src.price],
        ["price_per_m2", db.price_per_m2, src.pricePerSqm],
        ["area_m2", db.area_m2, src.area],
        ["rooms", db.rooms, src.rooms, "enum -> liczba"],
        ["floor_num / label", `${show(db.floor_num)} / ${show(db.floor_label)}`, src.floor, provenance("floor") ?? "enum -> liczba + etykieta"],
        ["floors_total", db.floors_total, src.buildingFloorsNum],
        ["year_built", db.year_built, src.buildYear, provenance("year_built")],
        ["rent", db.rent, src.rent, "0 = brak danych -> NULL"],
        ["district", db.district, src.district],
        ["street", db.street, src.street, provenance("street") ?? "sama cyfra -> NULL"],
        ["market", db.market, src.market],
        ["advertiser / seller", `${show(db.advertiser_type)} / ${show(db.seller_name)}`, `${show(src.sellerType)} / ${show(src.sellerName)}`],
        ["photos", db.photos_count, src.allImages?.length],
        ["photos_declared", db.photos_declared, src.totalPossibleImages],
      ];

      const width = Math.max(...pairs.map(([label]) => label.length));
      console.log(`${"pole".padEnd(width)}  ${"baza".padEnd(34)}  zrodlo (data/raw)`);
      console.log("-".repeat(96));
      for (const [label, dbValue, srcValue, note] of pairs) {
        const same = show(dbValue) === show(srcValue);
        const marker = same ? " " : note ? "~" : "!";
        console.log(`${marker}${label.padEnd(width)}  ${show(dbValue).padEnd(34)}  ${show(srcValue)}${note && !same ? `   <- ${note}` : ""}`);
      }

      console.log(`\nflagi jakosci : ${show(db.quality_flags)}`);
      console.log(`zrodla pol    : ${show(db.field_sources)}`);
      console.log(`duplikaty     : ${show(db.duplicate_group_id)}${db.duplicate_group_id ? (db.is_canonical ? " (kanoniczna)" : " (ukryta kopia)") : ""}`);
      console.log(`cechy         : ${show(db.features)}`);
      console.log(`opis (200 zn.): ${(db.description_clean ?? "").replace(/\s+/g, " ").slice(0, 200)}...`);
    }

    console.log(`\nLegenda: "!" = roznica nieoczekiwana, "~" = roznica zamierzona przez regule normalizacji.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
