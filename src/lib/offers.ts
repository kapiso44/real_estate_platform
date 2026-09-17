/**
 * Reads for a single offer and for the dataset-wide metadata the UI needs
 * (district list, ranges, medians). Searching lives in search.ts.
 */
import { pool } from "@/lib/db";
import { toListItem, type OfferListItem } from "@/lib/search";

export interface DuplicateSibling {
  id: number;
  sourceUrl: string;
  price: number | null;
  areaM2: number | null;
  floorNum: number | null;
  district: string | null;
  isCanonical: boolean;
}

export interface OfferDetail extends OfferListItem {
  transactionType: string;
  city: string;
  descriptionClean: string | null;
  photos: string[];
  photosDeclared: number | null;
  rent: number | null;
  floorsTotal: number | null;
  buildingType: string | null;
  buildingMaterial: string | null;
  buildingOwnership: string | null;
  constructionStatus: string | null;
  heating: string | null;
  windowsType: string | null;
  advertiserType: string | null;
  sellerName: string | null;
  lat: number | null;
  lng: number | null;
  /** Provenance of values that were not taken verbatim from the search listing. */
  fieldSources: Record<string, { source: string; quote?: string }>;
  duplicateGroupId: string | null;
  isCanonical: boolean;
  duplicates: DuplicateSibling[];
  modifiedAt: string | null;
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const asObject = <T>(value: unknown): T => (value && typeof value === "object" ? (value as T) : ({} as T));

export async function getOfferById(id: number): Promise<OfferDetail | null> {
  const [rows] = await pool.query<any[]>("SELECT * FROM offers WHERE id = ?", [id]);
  const row = rows[0];
  if (!row) return null;

  let duplicates: DuplicateSibling[] = [];
  if (row.duplicate_group_id) {
    const [siblings] = await pool.query<any[]>(
      `SELECT id, source_url, price, area_m2, floor_num, district, is_canonical
       FROM offers WHERE duplicate_group_id = ? AND id <> ? ORDER BY is_canonical DESC, id`,
      [row.duplicate_group_id, id],
    );
    duplicates = siblings.map((sibling) => ({
      id: sibling.id,
      sourceUrl: sibling.source_url,
      price: sibling.price ?? null,
      areaM2: sibling.area_m2 ?? null,
      floorNum: sibling.floor_num ?? null,
      district: sibling.district ?? null,
      isCanonical: Boolean(sibling.is_canonical),
    }));
  }

  return {
    ...toListItem(row),
    transactionType: row.transaction_type,
    city: row.city,
    descriptionClean: row.description_clean ?? null,
    photos: asArray<string>(row.photos),
    photosDeclared: row.photos_declared ?? null,
    rent: row.rent ?? null,
    floorsTotal: row.floors_total ?? null,
    buildingType: row.building_type ?? null,
    buildingMaterial: row.building_material ?? null,
    buildingOwnership: row.building_ownership ?? null,
    constructionStatus: row.construction_status ?? null,
    heating: row.heating ?? null,
    windowsType: row.windows_type ?? null,
    advertiserType: row.advertiser_type ?? null,
    sellerName: row.seller_name ?? null,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    fieldSources: asObject<Record<string, { source: string; quote?: string }>>(row.field_sources),
    duplicateGroupId: row.duplicate_group_id ?? null,
    isCanonical: Boolean(row.is_canonical),
    duplicates,
    modifiedAt: row.modified_at ? new Date(row.modified_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Dataset metadata
// ---------------------------------------------------------------------------

export interface DistrictMeta {
  name: string;
  count: number;
  medianPricePerM2: number | null;
}

export interface OffersMeta {
  city: string;
  total: number;
  districts: DistrictMeta[];
  price: { min: number | null; median: number | null; max: number | null };
  area: { min: number | null; median: number | null; max: number | null };
  medianPricePerM2: number | null;
  markets: { market: string; count: number }[];
  features: { feature: string; count: number }[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 100) / 100;
}

/**
 * Computed in JS over the canonical rows: the dataset is ~100 offers, so a single scan is
 * cheaper and far clearer than window-function median SQL. Revisit if the dataset grows.
 */
export async function getMeta(): Promise<OffersMeta> {
  const [rows] = await pool.query<any[]>(
    `SELECT city, district, price, price_per_m2, area_m2, market, features
     FROM offers WHERE is_canonical = 1`,
  );

  const numbers = (pick: (row: any) => unknown) =>
    rows.map(pick).filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const byDistrict = new Map<string, number[]>();
  const byMarket = new Map<string, number>();
  const byFeature = new Map<string, number>();
  for (const row of rows) {
    const district = row.district ?? "(unknown)";
    const list = byDistrict.get(district) ?? [];
    if (typeof row.price_per_m2 === "number") list.push(row.price_per_m2);
    byDistrict.set(district, list);
    if (row.market) byMarket.set(row.market, (byMarket.get(row.market) ?? 0) + 1);
    for (const feature of asArray<string>(row.features)) {
      byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
    }
  }

  const districtCounts = new Map<string, number>();
  for (const row of rows) {
    const district = row.district ?? "(unknown)";
    districtCounts.set(district, (districtCounts.get(district) ?? 0) + 1);
  }

  const prices = numbers((row) => row.price);
  const areas = numbers((row) => row.area_m2);

  return {
    city: rows[0]?.city ?? "Gdańsk",
    total: rows.length,
    districts: [...districtCounts.entries()]
      .map(([name, count]) => ({ name, count, medianPricePerM2: median(byDistrict.get(name) ?? []) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    price: { min: prices.length ? Math.min(...prices) : null, median: median(prices), max: prices.length ? Math.max(...prices) : null },
    area: { min: areas.length ? Math.min(...areas) : null, median: median(areas), max: areas.length ? Math.max(...areas) : null },
    medianPricePerM2: median(numbers((row) => row.price_per_m2)),
    markets: [...byMarket.entries()].map(([market, count]) => ({ market, count })).sort((a, b) => b.count - a.count),
    features: [...byFeature.entries()].map(([feature, count]) => ({ feature, count })).sort((a, b) => b.count - a.count),
  };
}
