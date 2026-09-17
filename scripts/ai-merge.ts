/**
 * Stage 2c: validate the subagents' output and merge it into one committed file.
 *
 * No AI here - only deterministic rules. Every proposed value must survive:
 *   - its quote being a literal fragment of that offer's description,
 *   - the closed feature vocabulary,
 *   - not overwriting a value the database already has,
 *   - range sanity (floor <= building height, plausible year),
 *   - amounts actually appearing in their own quote,
 *   - summaries containing no number that is absent from the source.
 *
 * Whatever fails is dropped and logged with a reason. The rejection count is a deliverable:
 * it shows how much of the model's output was not taken on trust.
 *
 *   npm run ai:merge
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./_db.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = join(ROOT, "data", "enriched", "output");
const MERGED_FILE = join(ROOT, "data", "enriched", "otodom-ai.json");
const REJECTED_LOG = join(ROOT, "data", "enriched", "rejected.log");

const FEATURE_VOCABULARY = new Set([
  "balcony", "terrace", "garden", "elevator", "parking", "storage",
  "air_conditioning", "ready_to_move_in", "needs_renovation", "developer_standard",
]);
const PRICE_NOTE_TYPES = new Set(["mandatory_parking", "extra_cost", "vat_note", "other"]);
const YEAR_RANGE: [number, number] = [1800, new Date().getFullYear() + 5];

/** Whitespace and case are normalized before comparing; nothing else is. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** Digits only, so "150 000 zł" and "150.000" both become "150000". */
const digitsOf = (text: string) => text.replace(/\D/g, "");

/**
 * Checks that an amount is actually backed by its quote.
 *
 * Listings write large sums in shorthand - "60 tys. zł", "100 tyś", "1,2 mln" - and the model
 * expands them to a full number. That expansion is arithmetic, not invention, so it is accepted
 * when the shorthand in the quote evaluates to exactly the stated amount. Anything else is
 * rejected, including a number the quote never mentions.
 */
function amountBackedByQuote(amount: number, quote: string): boolean {
  if (digitsOf(quote).includes(digitsOf(String(amount)))) return true;
  for (const match of quote.matchAll(/(\d+(?:[.,]\d+)?)\s*(tys|tyś|tysi[ęe]c\w*|mln|milion\w*)/gi)) {
    const value = Number(match[1].replace(",", "."));
    const multiplier = /mln|milion/i.test(match[2]) ? 1_000_000 : 1_000;
    if (Number.isFinite(value) && Math.round(value * multiplier) === amount) return true;
  }
  return false;
}

interface Rejection { id: number | string; field: string; reason: string; value: string }

interface EnrichedOffer {
  summary?: string;
  features: { feature: string; quote: string }[];
  priceNotes: { type: string; amountPln?: number; quote: string }[];
  floor?: { value: number; quote: string };
  yearBuilt?: { value: number; quote: string };
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) throw new Error(`${OUTPUT_DIR} does not exist — run the enrichment subagents first`);

  const { pool } = connect();
  const rejections: Rejection[] = [];
  const merged: Record<string, EnrichedOffer> = {};

  try {
    // The "does the source already have this?" baseline MUST come from offers_raw, not from
    // offers: normalization writes accepted AI values into offers, so comparing against that
    // table would reject on the second run whatever the first run accepted, and the value
    // would be lost. offers_raw is never touched by AI, so the check stays stable.
    const [rows] = await pool.query<any[]>(`
      SELECT o.id, o.title, o.description_clean, o.floors_total,
             o.price, o.price_per_m2, o.area_m2, o.rooms,
             JSON_EXTRACT(r.payload, '$.buildYear') AS source_year_built,
             JSON_EXTRACT(r.payload, '$.floor') AS source_floor
      FROM offers o JOIN offers_raw r ON r.id = o.id`);
    /** MySQL hands back JSON null as the string "null" - both mean "the source said nothing". */
    const fromSource = (value: unknown) =>
      value === null || value === undefined || value === "null" ? null : value;
    const offers = new Map<number, any>(
      rows.map((row) => [
        row.id,
        { ...row, source_year_built: fromSource(row.source_year_built), source_floor: fromSource(row.source_floor) },
      ]),
    );

    const files = readdirSync(OUTPUT_DIR).filter((name) => name.endsWith(".json")).sort();
    if (files.length === 0) throw new Error(`no batch files in ${OUTPUT_DIR}`);

    let promptVersion: number | null = null;
    let seen = 0;

    for (const file of files) {
      let parsed: any;
      try {
        parsed = JSON.parse(readFileSync(join(OUTPUT_DIR, file), "utf8"));
      } catch (err) {
        rejections.push({ id: file, field: "file", reason: `unparsable JSON: ${(err as Error).message}`, value: "" });
        continue;
      }
      promptVersion ??= parsed.prompt_version ?? null;

      for (const result of parsed.results ?? []) {
        seen++;
        const offer = offers.get(result.id);
        if (!offer) {
          rejections.push({ id: result.id, field: "offer", reason: "id not present in offers table", value: "" });
          continue;
        }
        const description = normalize(offer.description_clean ?? "");
        const quoteIsReal = (quote: unknown) =>
          typeof quote === "string" && quote.trim() !== "" && description.includes(normalize(quote));

        const entry: EnrichedOffer = { features: [], priceNotes: [] };

        // --- summary: no number that does not occur in the source ------------------------
        if (typeof result.summary === "string" && result.summary.trim()) {
          const sourceDigits = new Set(
            [offer.title, offer.description_clean, offer.price, offer.price_per_m2, offer.area_m2, offer.rooms,
             offer.source_year_built, offer.source_floor, offer.floors_total]
              .filter((value) => value != null)
              .flatMap((value) => String(value).match(/\d+/g) ?? []),
          );
          const invented = (result.summary.match(/\d+/g) ?? []).filter((n: string) => !sourceDigits.has(n));
          if (invented.length) {
            rejections.push({ id: result.id, field: "summary", reason: `number(s) not in source: ${invented.join(", ")}`, value: result.summary.slice(0, 120) });
          } else {
            entry.summary = result.summary.trim();
          }
        }

        // --- features: closed vocabulary + verbatim quote ---------------------------------
        for (const feature of result.features ?? []) {
          if (!FEATURE_VOCABULARY.has(feature?.feature)) {
            rejections.push({ id: result.id, field: "feature", reason: "outside the allowed vocabulary", value: String(feature?.feature) });
            continue;
          }
          if (!quoteIsReal(feature.quote)) {
            rejections.push({ id: result.id, field: `feature:${feature.feature}`, reason: "quote is not a literal fragment of the description", value: String(feature.quote).slice(0, 120) });
            continue;
          }
          entry.features.push({ feature: feature.feature, quote: feature.quote });
        }

        // --- price notes: type, quote, and the amount must be inside its own quote --------
        for (const note of result.price_notes ?? []) {
          if (!PRICE_NOTE_TYPES.has(note?.type)) {
            rejections.push({ id: result.id, field: "price_note", reason: "unknown type", value: String(note?.type) });
            continue;
          }
          if (!quoteIsReal(note.quote)) {
            rejections.push({ id: result.id, field: `price_note:${note.type}`, reason: "quote is not a literal fragment of the description", value: String(note.quote).slice(0, 120) });
            continue;
          }
          if (note.amount_pln != null) {
            const amount = Number(note.amount_pln);
            if (!Number.isFinite(amount) || !amountBackedByQuote(amount, note.quote)) {
              rejections.push({ id: result.id, field: `price_note:${note.type}`, reason: `amount ${note.amount_pln} does not appear in its quote`, value: String(note.quote).slice(0, 120) });
              continue;
            }
            entry.priceNotes.push({ type: note.type, amountPln: amount, quote: note.quote });
          } else {
            entry.priceNotes.push({ type: note.type, quote: note.quote });
          }
        }

        // --- floor: only where the database has nothing, and within the building ---------
        if (result.floor) {
          const value = Number(result.floor.value);
          const reason = offer.source_floor !== null
            ? "source data already states a floor — AI must not overwrite it"
            : !Number.isInteger(value) || value < 0 || value > 50
              ? `implausible floor ${result.floor.value}`
              : offer.floors_total != null && value > offer.floors_total
                ? `floor ${value} exceeds building height ${offer.floors_total}`
                : !quoteIsReal(result.floor.quote)
                  ? "quote is not a literal fragment of the description"
                  : null;
          if (reason) rejections.push({ id: result.id, field: "floor", reason, value: String(result.floor.value) });
          else entry.floor = { value, quote: result.floor.quote };
        }

        // --- year built: same discipline -------------------------------------------------
        if (result.year_built) {
          const value = Number(result.year_built.value);
          const reason = offer.source_year_built !== null
            ? "source data already states a build year — AI must not overwrite it"
            : !Number.isInteger(value) || value < YEAR_RANGE[0] || value > YEAR_RANGE[1]
              ? `implausible year ${result.year_built.value}`
              : !quoteIsReal(result.year_built.quote)
                ? "quote is not a literal fragment of the description"
                : null;
          if (reason) rejections.push({ id: result.id, field: "year_built", reason, value: String(result.year_built.value) });
          else entry.yearBuilt = { value, quote: result.year_built.quote };
        }

        merged[String(result.id)] = entry;
      }
    }

    mkdirSync(dirname(MERGED_FILE), { recursive: true });
    writeFileSync(
      MERGED_FILE,
      JSON.stringify({ promptVersion, generatedFrom: files, offers: merged }, null, 2) + "\n",
    );
    writeFileSync(
      REJECTED_LOG,
      [`# ai-merge — ${rejections.length} rejected values out of ${seen} offers processed`, "# id\tfield\treason\tvalue"]
        .concat(rejections.map((r) => `${r.id}\t${r.field}\t${r.reason}\t${r.value.replace(/\s+/g, " ")}`))
        .join("\n") + "\n",
    );

    const withSummary = Object.values(merged).filter((entry) => entry.summary).length;
    const withNotes = Object.values(merged).filter((entry) => entry.priceNotes.length).length;
    const withFloor = Object.values(merged).filter((entry) => entry.floor).length;
    const withYear = Object.values(merged).filter((entry) => entry.yearBuilt).length;
    console.log(`merged ${Object.keys(merged).length} offers from ${files.length} batch files`);
    console.log(`  summaries: ${withSummary} | price notes: ${withNotes} | inferred floor: ${withFloor} | inferred year: ${withYear}`);
    console.log(`  rejected values: ${rejections.length} (see ${REJECTED_LOG})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
