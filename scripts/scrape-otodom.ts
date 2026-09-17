/**
 * Otodom scraper: ~100 flats for sale in Gdańsk.
 *
 * Run (Node >= 23.6, type stripping, zero dependencies):
 *   node scripts/scrape-otodom.ts                 # uses cache where available
 *   node scripts/scrape-otodom.ts --refresh-lists  # re-download search result pages
 *
 * Outputs:
 *   data/raw/otodom-offers.json          flat records for MySQL import / normalization
 *   data/raw/otodom-offers-preview.html  static card grid for eyeballing data quality
 *   data/raw/otodom-offers-errors.log    offers that failed to fetch/parse, with reason
 *
 * Raw HTTP responses are cached in .cache/otodom/, so re-runs are idempotent and
 * only hit the network for things not downloaded yet.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, ".cache", "otodom");
const LIST_CACHE_DIR = join(CACHE_DIR, "list");
const OUT_DIR = join(ROOT, "data", "raw");
const OUT_JSON = join(OUT_DIR, "otodom-offers.json");
const OUT_HTML = join(OUT_DIR, "otodom-offers-preview.html");
const OUT_ERRORS = join(OUT_DIR, "otodom-offers-errors.log");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const SEARCH_URL =
  "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/pomorskie/gdansk/gdansk/gdansk?by=LATEST&direction=DESC&limit=72&page=";
const OFFER_URL = "https://www.otodom.pl/pl/oferta/";
const TARGET_OFFERS = 100;
const LIST_PAGES = 2; // 2 x (72 - 1 fake duplicate) = ~142 candidates, headroom for failed details
const MAX_RETRIES = 2;

const refreshLists = process.argv.includes("--refresh-lists");

// ---------------------------------------------------------------------------
// Types (only the parts of Otodom's __NEXT_DATA__ that we read)
// ---------------------------------------------------------------------------

type Money = { value: number; currency: string } | null;

interface ListItem {
  id: number;
  slug: string;
  title: string;
  estate: string;
  href: string;
  totalPrice: Money;
  pricePerSquareMeter: Money;
  areaInSquareMeters: number | null;
  roomsNumber: string | null;
  floorNumber: string | null;
  location?: {
    address?: { city?: { name?: string } | null; street?: { name?: string } | null };
    reverseGeocoding?: { locations?: { name: string; locationLevel: string }[] };
  };
  shortDescription: string | null;
  images: { large: string }[] | null;
  totalPossibleImages: number | null;
  isPromoted: boolean;
  isPrivateOwner: boolean;
  advertOwner?: { name?: string } | null;
  agency?: { name?: string; type?: string } | null;
  rentPrice: Money;
  transaction: string | null;
  dateCreated: string | null;
}

interface AdDetail {
  id: number;
  url?: string | null;
  market?: string | null;
  description?: string | null;
  modifiedAt?: string | null;
  shouldShowExpiredAdPage?: boolean;
  adCategory?: { name?: string } | null;
  attributes?: Record<string, string | string[] | undefined> | null;
  location?: {
    coordinates?: { latitude?: number; longitude?: number } | null;
    address?: { street?: { name?: string | null } | null } | null;
  } | null;
  images?: { large: string }[] | null;
  // contactDetails (name + phone) is deliberately not read: personal data stays out of the repo.
}

export interface OtodomOffer {
  id: number;
  slug: string;
  offerUrl: string;
  title: string;
  price: number | null;
  currency: string | null;
  pricePerSqm: number | null;
  area: number | null;
  rooms: string | null;
  floor: string | null;
  city: string | null;
  district: string | null;
  street: string | null;
  /** Which page the street came from: the search listing is primary, the offer page is a fallback. */
  streetSource: "list" | "detail" | null;
  transaction: string | null;
  /** Monthly administrative fee ("czynsz"), NOT a rental price. 0 means "not provided" here. */
  rent: number | null;
  shortDescription: string | null;
  thumbnailImages: string[];
  totalPossibleImages: number | null;
  isPromoted: boolean;
  isPrivateOwner: boolean;
  sellerName: string | null;
  sellerType: string | null;
  dateCreated: string | null;
  // detail page
  market: string | null;
  buildYear: number | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  allImages: string[];
  buildingFloorsNum: number | null;
  buildingType: string | null;
  buildingOwnership: string | null;
  heating: string | null;
  windowsType: string | null;
  equipmentTypes: string[];
  extrasTypes: string[];
  securityTypes: string[];
  constructionStatus: string | null;
  buildingMaterial: string | null;
  modifiedAt: string | null;
  scrapedAt: string;
}

// ---------------------------------------------------------------------------
// HTTP with politeness delay, retries and on-disk cache
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
let networkRequests = 0;

class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function politeFetch(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + 1000 + Math.random() * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    networkRequests++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, redirect: "follow" });
      if (res.ok) return await res.text();
      // 404/410 = offer gone; retrying won't help
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw new HttpError(res.status, url);
    } catch (err) {
      if (err instanceof HttpError || attempt >= MAX_RETRIES) throw err;
    }
    await sleep(3000 * (attempt + 1));
  }
}

/** Returns cached body if present, otherwise downloads and caches (only successful responses). */
async function cachedFetch(url: string, cacheFile: string): Promise<{ body: string; fromCache: boolean }> {
  if (existsSync(cacheFile)) return { body: readFileSync(cacheFile, "utf8"), fromCache: true };
  const body = await politeFetch(url);
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, body);
  return { body, fromCache: false };
}

function extractNextData(html: string): any {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ script not found");
  return JSON.parse(m[1]);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  oacute: "ó", Oacute: "Ó", ndash: "–", mdash: "—", hellip: "…", bdquo: "„",
  rdquo: "”", ldquo: "“", rsquo: "’", lsquo: "‘", sup2: "²", deg: "°", bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code] ?? whole;
  });
}

/** HTML description -> plain text; paragraphs separated by a blank line. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|ul|ol)>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? redactContacts(text) : null;
}

/**
 * Sellers sometimes paste a phone number or an e-mail into the description body.
 * That is personal data and data/raw/ is committed, so it is removed at the source.
 * Everything else in the text stays verbatim.
 */
function redactContacts(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, "[email removed]")
    .replace(/(?:\+?\s?48[\s-]?)?(?:\d[\s-]?){8}\d/g, (match) =>
      (match.match(/\d/g) ?? []).length >= 9 ? "[phone removed]" : match,
    );
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

function isFakeDuplicate(item: ListItem, seenSlugs: Set<string>): boolean {
  return (item.href ?? "").startsWith("hpr/") || seenSlugs.has(item.slug);
}

function fromListItem(item: ListItem): Omit<OtodomOffer, keyof DetailFields | "scrapedAt"> {
  const districts = (item.location?.reverseGeocoding?.locations ?? []).filter((l) => l.locationLevel === "district");
  return {
    id: item.id,
    slug: item.slug,
    offerUrl: OFFER_URL + item.slug,
    title: item.title,
    price: item.totalPrice?.value ?? null,
    currency: item.totalPrice?.currency ?? null,
    pricePerSqm: item.pricePerSquareMeter?.value ?? null,
    area: item.areaInSquareMeters ?? null,
    rooms: item.roomsNumber ?? null,
    floor: item.floorNumber ?? null,
    city: str(item.location?.address?.city?.name),
    district: districts.at(-1)?.name ?? null,
    street: str(item.location?.address?.street?.name),
    streetSource: str(item.location?.address?.street?.name) ? "list" : null,
    transaction: str(item.transaction),
    rent: item.rentPrice?.value ?? null,
    shortDescription: str(item.shortDescription) && redactContacts(item.shortDescription!),
    thumbnailImages: (item.images ?? []).map((i) => i.large).filter(Boolean),
    totalPossibleImages: item.totalPossibleImages ?? null,
    isPromoted: Boolean(item.isPromoted),
    isPrivateOwner: Boolean(item.isPrivateOwner),
    // Only the agency (a company) is stored. advertOwner.name is a natural person's name,
    // i.e. personal data, so it never leaves the cache.
    sellerName: item.isPrivateOwner ? null : str(item.agency?.name),
    sellerType: item.isPrivateOwner ? "PRIVATE" : str(item.agency?.type),
    dateCreated: item.dateCreated ?? null,
  };
}

type DetailFields = Pick<
  OtodomOffer,
  | "market" | "buildYear" | "description" | "latitude" | "longitude" | "allImages"
  | "buildingFloorsNum" | "buildingType" | "buildingOwnership" | "heating" | "windowsType"
  | "equipmentTypes" | "extrasTypes" | "securityTypes" | "constructionStatus" | "buildingMaterial"
  | "modifiedAt"
>;

function fromDetail(ad: AdDetail): DetailFields {
  const a = ad.attributes ?? {};
  const lat = num(ad.location?.coordinates?.latitude);
  const lng = num(ad.location?.coordinates?.longitude);
  return {
    market: str(ad.market),
    buildYear: num(a.build_year),
    description: htmlToText(ad.description),
    // 0,0 would be a placeholder, not a real location
    latitude: lat && lng ? lat : null,
    longitude: lat && lng ? lng : null,
    allImages: (ad.images ?? []).map((i) => i.large).filter(Boolean),
    buildingFloorsNum: num(a.building_floors_num),
    buildingType: str(a.building_type),
    buildingOwnership: str(a.building_ownership),
    heating: str(a.heating),
    windowsType: str(a.windows_type),
    equipmentTypes: arr(a.equipment_types),
    extrasTypes: arr(a.extras_types),
    securityTypes: arr(a.security_types),
    constructionStatus: str(a.construction_status),
    buildingMaterial: str(a.building_material),
    modifiedAt: str(ad.modifiedAt),
  };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

interface ErrorEntry { id: number | string; url: string; reason: string }

async function collectCandidates(errors: ErrorEntry[]): Promise<ListItem[]> {
  if (refreshLists) rmSync(LIST_CACHE_DIR, { recursive: true, force: true });
  const candidates: ListItem[] = [];
  const seenIds = new Set<number>();
  const seenSlugs = new Set<string>();

  for (let page = 1; page <= LIST_PAGES; page++) {
    const url = SEARCH_URL + page;
    try {
      const { body, fromCache } = await cachedFetch(url, join(LIST_CACHE_DIR, `page-${page}.html`));
      const items: ListItem[] = extractNextData(body)?.props?.pageProps?.data?.searchAds?.items;
      if (!Array.isArray(items)) throw new Error("props.pageProps.data.searchAds.items missing");
      let added = 0, skipped = 0;
      for (const item of items) {
        // Fake duplicate of the first ad (14-digit id, hpr/ link) and cross-page repeats
        // (sorting by LATEST shifts items between pages while we crawl).
        if (isFakeDuplicate(item, seenSlugs) || seenIds.has(item.id)) { skipped++; continue; }
        seenIds.add(item.id);
        seenSlugs.add(item.slug);
        if (item.estate !== "FLAT") {
          errors.push({ id: item.id, url: OFFER_URL + item.slug, reason: `skipped: estate=${item.estate}` });
          continue;
        }
        candidates.push(item);
        added++;
      }
      console.log(`list page ${page}${fromCache ? " (cache)" : ""}: ${items.length} items, ${added} candidates, ${skipped} duplicates skipped`);
    } catch (err) {
      errors.push({ id: `list-page-${page}`, url, reason: String((err as Error).message ?? err) });
      console.error(`list page ${page} failed: ${(err as Error).message}`);
    }
  }
  return candidates;
}

async function enrich(candidates: ListItem[], errors: ErrorEntry[]): Promise<OtodomOffer[]> {
  const offers: OtodomOffer[] = [];
  const scrapedAt = new Date().toISOString();

  for (const item of candidates) {
    if (offers.length >= TARGET_OFFERS) break;
    const base = fromListItem(item);
    try {
      const { body, fromCache } = await cachedFetch(base.offerUrl, join(CACHE_DIR, `${item.id}.html`));
      const ad: AdDetail | undefined = extractNextData(body)?.props?.pageProps?.ad;
      if (!ad) throw new Error("props.pageProps.ad missing");
      if (ad.shouldShowExpiredAdPage) throw new Error("offer expired (shouldShowExpiredAdPage)");
      if (ad.id !== item.id) throw new Error(`id mismatch: list ${item.id} vs detail ${ad.id}`);
      const category = ad.adCategory?.name;
      if (category && category !== "FLAT") throw new Error(`skipped: detail adCategory=${category}`);
      if (base.city !== "Gdańsk") throw new Error(`skipped: city=${base.city}`);

      // The list slug can differ from the canonical one (e.g. "|" handling), which makes
      // Otodom answer with a 308. Prefer the canonical URL from the detail page.
      const canonical = str(ad.url)?.startsWith(OFFER_URL) ? { slug: ad.url!.slice(OFFER_URL.length), offerUrl: ad.url! } : {};
      // The listing is the primary source; the offer page only fills gaps (7 extra streets).
      const detailStreet = str(ad.location?.address?.street?.name);
      const street = base.street
        ? { street: base.street, streetSource: "list" as const }
        : detailStreet
          ? { street: detailStreet, streetSource: "detail" as const }
          : { street: null, streetSource: null };
      offers.push({ ...base, ...canonical, ...street, ...fromDetail(ad), scrapedAt });
      console.log(`[${offers.length}/${TARGET_OFFERS}] ${item.id}${fromCache ? " (cache)" : ""} ${base.title.slice(0, 60)}`);
    } catch (err) {
      const reason = String((err as Error).message ?? err);
      errors.push({ id: item.id, url: base.offerUrl, reason });
      console.error(`offer ${item.id} failed: ${reason}`);
    }
  }
  return offers;
}

// ---------------------------------------------------------------------------
// Preview HTML
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtNum = (n: number | null, suffix = "") =>
  n == null ? "—" : n.toLocaleString("pl-PL", { maximumFractionDigits: 2 }) + suffix;

const ROOMS: Record<string, string> = { ONE: "1", TWO: "2", THREE: "3", FOUR: "4", FIVE: "5", SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", TEN: "10", MORE: "10+" };

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function renderPreview(offers: OtodomOffer[], errors: ErrorEntry[]): string {
  const count = (pred: (o: OtodomOffer) => boolean) => offers.filter(pred).length;
  const areas = offers.map((o) => o.area).filter((n): n is number => n != null).sort((a, b) => a - b);
  const prices = offers.map((o) => o.price).filter((n): n is number => n != null).sort((a, b) => a - b);
  const descCounts = new Map<string, number>();
  for (const o of offers) if (o.description) descCounts.set(o.description, (descCounts.get(o.description) ?? 0) + 1);

  const stats: [string, string | number, boolean?][] = [
    ["ofert", offers.length],
    ["błędów / pominiętych", errors.length, errors.length > 0],
    ["brak opisu", count((o) => !o.description), true],
    ["opis < 200 znaków", count((o) => (o.description?.length ?? 0) < 200), true],
    ["brak zdjęć", count((o) => o.allImages.length === 0), true],
    ["niepełne zdjęcia (pobrane < deklarowane)", count((o) => o.totalPossibleImages != null && o.allImages.length < o.totalPossibleImages), true],
    ["brak współrzędnych", count((o) => o.latitude == null), true],
    ["brak roku budowy", count((o) => o.buildYear == null), true],
    ["brak piętra", count((o) => o.floor == null), true],
    ["opis identyczny z inną ofertą", count((o) => o.description != null && (descCounts.get(o.description) ?? 0) > 1), true],
    ["więcej zdjęć niż deklarowane na liście", count((o) => o.totalPossibleImages != null && o.allImages.length > o.totalPossibleImages), true],
    ["brak ceny", count((o) => o.price == null), true],
    ["brak metrażu", count((o) => o.area == null), true],
    ["brak dzielnicy", count((o) => !o.district), true],
    ["brak ulicy", count((o) => !o.street), true],
    ["rynek pierwotny / wtórny", `${count((o) => o.market === "PRIMARY")} / ${count((o) => o.market === "SECONDARY")}`],
    ["prywatni / agencje", `${count((o) => o.isPrivateOwner)} / ${count((o) => !o.isPrivateOwner)}`],
    ["metraż min / mediana / max", `${fmtNum(areas[0] ?? null)} / ${fmtNum(quantile(areas, 0.5))} / ${fmtNum(areas.at(-1) ?? null)} m²`],
    ["cena min / mediana / max", `${fmtNum(prices[0] ?? null)} / ${fmtNum(quantile(prices, 0.5))} / ${fmtNum(prices.at(-1) ?? null)} zł`],
  ];

  const statHtml = stats
    .map(([label, value, flag]) => {
      const warn = flag && typeof value === "number" && value > 0;
      return `<div class="stat${warn ? " warn" : ""}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
    })
    .join("");

  const cards = offers
    .map((o) => {
      const img = o.allImages[0] ?? o.thumbnailImages[0];
      const declared = o.totalPossibleImages ?? "?";
      const incomplete = o.totalPossibleImages != null && o.allImages.length < o.totalPossibleImages;
      const desc = o.description ?? o.shortDescription ?? "";
      const flags = [
        !o.description && "brak opisu",
        o.latitude == null && "brak współrzędnych",
        o.buildYear == null && "brak roku budowy",
        !o.district && "brak dzielnicy",
      ].filter(Boolean);
      const debugJson = JSON.stringify(o, null, 2);
      return `<article class="card">
  <div class="img">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="noimg">brak zdjęć</div>`}
    <span class="badge${incomplete || !o.allImages.length ? " warn" : ""}">${o.allImages.length}/${declared} zdjęć</span>
    ${o.isPromoted ? `<span class="badge promo">promowane</span>` : ""}
  </div>
  <div class="body">
    <div class="price">${fmtNum(o.price, " zł")} <small>${fmtNum(o.pricePerSqm, " zł/m²")}</small></div>
    <div class="facts">${fmtNum(o.area, " m²")} · ${o.rooms ? ROOMS[o.rooms] ?? o.rooms : "?"} pok. · piętro ${esc(o.floor ?? "?")} · ${esc(o.market ?? "?")}${o.buildYear ? ` · ${o.buildYear}` : ""}</div>
    <div class="loc">${esc(o.city ?? "?")}${o.district ? ` / ${esc(o.district)}` : ""}${o.street ? ` · ${esc(o.street)}` : ""}</div>
    <h3>${esc(o.title)}</h3>
    <p>${esc(desc.replace(/\s+/g, " ").slice(0, 150))}${desc.length > 150 ? "…" : ""}</p>
    ${flags.length ? `<div class="flags">${flags.map((f) => `<span>${f}</span>`).join("")}</div>` : ""}
    <div class="meta">${esc(o.sellerType ?? "?")}: ${esc(o.sellerName ?? "?")} · id ${o.id}</div>
    <a href="${esc(o.offerUrl)}" target="_blank" rel="noopener noreferrer">zobacz oryginalne ogłoszenie →</a>
    <details><summary>surowy JSON</summary><pre>${esc(debugJson)}</pre></details>
  </div>
</article>`;
    })
    .join("\n");

  const errorHtml = errors.length
    ? `<details class="errors"><summary>${errors.length} błędów / pominiętych</summary><ul>${errors
        .map((e) => `<li><code>${esc(e.id)}</code> <a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.url)}</a> — ${esc(e.reason)}</li>`)
        .join("")}</ul></details>`
    : "";

  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Otodom Gdańsk — podgląd danych</title>
<style>
  :root { --bg:#f5f5f2; --card:#fff; --ink:#1d1d1b; --muted:#6b6b66; --line:#e2e2dc; --warn:#b3471d; --warn-bg:#fbe9e1; --accent:#1f5fbf; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { max-width:1400px; margin:0 auto 20px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 16px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fill, minmax(170px, 1fr)); gap:8px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .stat b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--muted); font-size:12px; }
  .stat.warn { border-color:#e9b9a5; background:var(--warn-bg); }
  .stat.warn b { color:var(--warn); }
  .errors { margin-top:12px; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .errors li { margin:4px 0; word-break:break-all; }
  main { max-width:1400px; margin:0 auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .img { position:relative; aspect-ratio:4/3; background:#ddd; }
  .img img { width:100%; height:100%; object-fit:cover; display:block; }
  .noimg { display:grid; place-items:center; height:100%; color:var(--warn); font-weight:600; }
  .badge { position:absolute; top:8px; left:8px; background:rgba(0,0,0,.7); color:#fff; font-size:12px; padding:2px 8px; border-radius:99px; }
  .badge.warn { background:var(--warn); }
  .badge.promo { left:auto; right:8px; background:var(--accent); }
  .body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:4px; flex:1; }
  .price { font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
  .price small { font-weight:400; color:var(--muted); font-size:12px; }
  .facts, .loc, .meta { color:var(--muted); font-size:13px; }
  h3 { font-size:14px; margin:6px 0 0; }
  p { margin:0; color:#3a3a36; }
  .flags { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .flags span { background:var(--warn-bg); color:var(--warn); font-size:11px; padding:1px 6px; border-radius:4px; }
  a { color:var(--accent); font-weight:600; margin-top:6px; }
  details summary { cursor:pointer; color:var(--muted); font-size:12px; margin-top:6px; }
  pre { max-height:320px; overflow:auto; background:#f3f3ef; padding:8px; font-size:11px; white-space:pre-wrap; word-break:break-word; }
</style>
</head>
<body>
<header>
  <h1>Otodom — mieszkania na sprzedaż, Gdańsk</h1>
  <p class="sub">Wygenerowano ${esc(new Date().toLocaleString("pl-PL"))} · zdjęcia hotlinkowane z CDN Otodom · bez danych kontaktowych</p>
  <div class="stats">${statHtml}</div>
  ${errorHtml}
</header>
<main>
${cards}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

async function main() {
  const errors: ErrorEntry[] = [];
  const candidates = await collectCandidates(errors);
  console.log(`${candidates.length} unique flat candidates from ${LIST_PAGES} list pages`);

  const offers = await enrich(candidates, errors);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(offers, null, 2) + "\n");
  writeFileSync(OUT_HTML, renderPreview(offers, errors));
  writeFileSync(
    OUT_ERRORS,
    [`# otodom scrape ${new Date().toISOString()} — ${errors.length} entries`, "# id\turl\treason"]
      .concat(errors.map((e) => `${e.id}\t${e.url}\t${e.reason}`))
      .join("\n") + "\n",
  );

  console.log(`\n${offers.length} offers -> ${OUT_JSON}`);
  console.log(`preview -> ${OUT_HTML}`);
  console.log(`${errors.length} errors -> ${OUT_ERRORS}`);
  console.log(`network requests this run: ${networkRequests}`);
  if (offers.length < TARGET_OFFERS) console.warn(`warning: only ${offers.length}/${TARGET_OFFERS} offers collected`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
