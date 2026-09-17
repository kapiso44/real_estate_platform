/**
 * Stage 1g: data quality report over the offers table.
 *
 * Deterministic (no timestamps in the output) so two consecutive normalization runs
 * can be compared byte for byte. This is the raw material for the reasoning one-pager.
 */
import { connect } from "./_db.ts";

const NULLABLE_COLUMNS = [
  "description_clean", "price", "price_per_m2", "rent", "area_m2", "rooms", "floor_num",
  "floor_label", "floors_total", "year_built", "market", "advertiser_type", "seller_name",
  "district", "street", "lat", "building_type", "building_material", "building_ownership",
  "construction_status", "heating", "windows_type", "ai_summary",
];

function table(rows: (string | number)[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  return rows
    .map((row) => row.map((cell, i) => (i === 0 ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]))).join("  "))
    .join("\n");
}

async function main() {
  const { pool } = connect();
  try {
    const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await pool.query<any[]>(sql, params))[0] as T[];

    const [{ total }] = await q("SELECT COUNT(*) AS total FROM offers");
    const [{ canonical }] = await q("SELECT COUNT(*) AS canonical FROM offers WHERE is_canonical = 1");
    console.log(`# Offers: ${total} (canonical: ${canonical})\n`);

    const missing = NULLABLE_COLUMNS.map((column) => `SUM(\`${column}\` IS NULL) AS \`${column}\``).join(", ");
    const [missingRow] = await q(`SELECT ${missing} FROM offers`);
    const missingRows = Object.entries(missingRow)
      .map(([column, count]) => [column, Number(count), `${Math.round((Number(count) / Number(total)) * 100)}%`])
      .filter(([, count]) => Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    console.log("## Missing values (NULL)");
    console.log(missingRows.length ? table([["column", "count", "share"], ...missingRows]) : "none");

    const flags = await q(`
      SELECT flag, COUNT(*) AS count FROM offers,
        JSON_TABLE(quality_flags, '$[*]' COLUMNS (flag VARCHAR(64) PATH '$')) AS f
      GROUP BY flag ORDER BY count DESC, flag`);
    console.log("\n## Quality flags");
    console.log(flags.length ? table([["flag", "count"], ...flags.map((f) => [f.flag, Number(f.count)])]) : "none");

    const sources = await q(`
      SELECT field, source, COUNT(*) AS count FROM (
        SELECT 'street' AS field, JSON_UNQUOTE(JSON_EXTRACT(field_sources, '$.street.source')) AS source FROM offers
        UNION ALL SELECT 'floor', JSON_UNQUOTE(JSON_EXTRACT(field_sources, '$.floor.source')) FROM offers
        UNION ALL SELECT 'year_built', JSON_UNQUOTE(JSON_EXTRACT(field_sources, '$.year_built.source')) FROM offers
        UNION ALL SELECT 'features', JSON_UNQUOTE(JSON_EXTRACT(field_sources, '$.features.source')) FROM offers
      ) s WHERE source IS NOT NULL GROUP BY field, source ORDER BY count DESC`);
    console.log("\n## Inferred field sources (value not taken verbatim from the search listing)");
    console.log(sources.length ? table([["field", "source", "count"], ...sources.map((s) => [s.field, s.source, Number(s.count)])]) : "none");

    const ai = await q(`
      SELECT SUM(ai_summary IS NOT NULL) AS summaries,
             SUM(JSON_LENGTH(price_notes) > 0) AS with_price_notes,
             COALESCE(SUM(JSON_LENGTH(price_notes)), 0) AS price_notes_total
      FROM offers`);
    console.log("\n## AI enrichment");
    console.log(
      table([
        ["metric", "value"],
        ["offers with AI summary", Number(ai[0].summaries ?? 0)],
        ["offers with price notes", Number(ai[0].with_price_notes ?? 0)],
        ["price notes total", Number(ai[0].price_notes_total ?? 0)],
      ]),
    );

    const dupes = await q(`
      SELECT duplicate_group_id AS grp, id, price, area_m2, rooms, floor_num, district, is_canonical
      FROM offers WHERE duplicate_group_id IS NOT NULL ORDER BY duplicate_group_id, is_canonical DESC, id`);
    const groupCount = new Set(dupes.map((d) => d.grp)).size;
    console.log(`\n## Duplicate groups: ${groupCount} (${dupes.length} offers)`);
    if (dupes.length) {
      console.log(
        table([
          ["group", "id", "price", "area", "rooms", "floor", "district", "canonical"],
          ...dupes.map((d) => [
            d.grp, d.id, d.price ?? "-", d.area_m2 ?? "-", d.rooms ?? "-",
            d.floor_num ?? "-", d.district ?? "-", d.is_canonical ? "yes" : "no",
          ]),
        ]),
      );
    }

    const stats = await q(`
      SELECT MIN(area_m2) AS area_min, MAX(area_m2) AS area_max, MIN(price) AS price_min,
             MAX(price) AS price_max, SUM(market = 'PRIMARY') AS primary_market,
             SUM(market = 'SECONDARY') AS secondary_market,
             SUM(advertiser_type = 'PRIVATE') AS private_sellers
      FROM offers`);
    console.log("\n## Ranges");
    console.log(
      table([
        ["metric", "value"],
        ["area m2", `${stats[0].area_min} - ${stats[0].area_max}`],
        ["price pln", `${stats[0].price_min} - ${stats[0].price_max}`],
        ["market primary/secondary", `${stats[0].primary_market}/${stats[0].secondary_market}`],
        ["private sellers", String(stats[0].private_sellers)],
      ]),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
