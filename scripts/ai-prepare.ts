/**
 * Stage 2a: build the input batches for the enrichment subagents.
 *
 * Each batch file holds only what the model is allowed to see: the title, the cleaned
 * description, and two flags saying whether it may propose a floor / build year at all.
 * Offers are ordered by id and split deterministically, so re-running produces identical
 * files and a re-run of a single batch is meaningful.
 *
 *   npm run ai:prepare
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunk, connect } from "./_db.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_DIR = join(ROOT, "data", "enriched", "input");
const BATCH_SIZE = 10;

async function main() {
  const { pool } = connect();
  try {
    const [rows] = await pool.query<any[]>(`
      SELECT id, title, description_clean, floor_num, floor_label, floors_total, year_built
      FROM offers
      ORDER BY id`);

    const offers = rows
      .filter((row) => row.description_clean)
      .map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description_clean,
        // The model may only propose a value where the database has none.
        may_infer_floor: row.floor_num === null && row.floor_label === null,
        may_infer_year_built: row.year_built === null,
        // Context for the floor sanity check, so the model does not suggest floor 9 in a 4-storey block.
        building_floors: row.floors_total,
      }));

    mkdirSync(INPUT_DIR, { recursive: true });
    const batches = chunk(offers, BATCH_SIZE);
    batches.forEach((batch, index) => {
      const number = String(index + 1).padStart(2, "0");
      writeFileSync(join(INPUT_DIR, `batch-${number}.json`), JSON.stringify({ batch: index + 1, offers: batch }, null, 2) + "\n");
    });

    const skipped = rows.length - offers.length;
    console.log(`prepared ${batches.length} batches (${offers.length} offers, ${BATCH_SIZE} per batch) in ${INPUT_DIR}`);
    console.log(`may infer floor: ${offers.filter((o) => o.may_infer_floor).length}, year built: ${offers.filter((o) => o.may_infer_year_built).length}`);
    if (skipped) console.log(`skipped ${skipped} offers without a description`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
