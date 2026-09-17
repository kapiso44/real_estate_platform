/**
 * Stage 1e: load data/raw/otodom-offers.json into offers_raw, unchanged.
 *
 * Idempotent: re-running upserts the same 100 rows instead of duplicating them.
 * No network access - the file is the input.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { chunk, connect, schema } from "./_db.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "data", "raw", "otodom-offers.json");

type ScrapedOffer = { id: number; offerUrl: string; scrapedAt: string };

async function main() {
  const offers: ScrapedOffer[] = JSON.parse(readFileSync(INPUT, "utf8"));
  if (!Array.isArray(offers) || offers.length === 0) throw new Error(`no offers in ${INPUT}`);

  const { db, pool } = connect();
  try {
    const rows = offers.map((offer) => ({
      id: offer.id,
      source: "otodom",
      sourceUrl: offer.offerUrl,
      payload: offer,
      fetchedAt: new Date(offer.scrapedAt),
    }));

    for (const batch of chunk(rows, 25)) {
      await db
        .insert(schema.offersRaw)
        .values(batch)
        .onDuplicateKeyUpdate({
          set: {
            sourceUrl: sql`VALUES(source_url)`,
            payload: sql`VALUES(payload)`,
            fetchedAt: sql`VALUES(fetched_at)`,
          },
        });
    }

    const [[{ total }]] = await pool.query<any>("SELECT COUNT(*) AS total FROM offers_raw");
    console.log(`imported ${rows.length} offers, offers_raw now holds ${total} rows`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
