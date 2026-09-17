/**
 * The chat box without the LLM.
 *
 * Used when GEMINI_API_KEY is unset, or when the call fails or times out. It is a plain regex
 * parser over Polish and English phrasing - it understands less than the model, but it never
 * fails, needs no key and no network, so the product still demonstrates the same idea offline:
 * loose words in, real filters out. It emits the same ChatIntent, so everything downstream
 * (rules.ts, the API, the UI) is identical either way.
 */
import type { OffersMeta } from "@/lib/offers";
import { CHAT_FEATURES, type ChatIntent } from "@/lib/chat/types";
import { matchDistricts } from "@/lib/chat/rules";

const fold = (value: string): string =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** "600 000" / "1,2" / "1.2" -> a number. Thin spaces and dots are thousands separators here. */
function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s ]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const MIN_WORDS = /\b(od|min|minimum|minimalnie|at least|from|over|powyzej|wiecej niz)\b/;
const ROOM_WORDS = /(pokoj|pokoi|pokoje|pokojow|rooms?|bedrooms?)/;

const FEATURE_PATTERNS: [RegExp, (typeof CHAT_FEATURES)[number]][] = [
  [/\bwind[ay]|\bwindzie|\belevator|\blift\b/, "elevator"],
  [/\bgaraz|\bparking|\bmiejsc\w* postojow|\bpostojowe/, "parking"],
  [/\bpiwnic|\bkomork|\bschowek|\bstorage|\bbasement/, "storage"],
  [/\bochron|\bmonitoring|\bdomofon|\bstrzezon|\bsecure|\bsecurity/, "security"],
  [/\bagd\b|\bzmywark|\bpralk|\blodowk|\bappliance/, "appliances"],
  [/\bumeblowan|\bmeblami|\bfurnished/, "furnished"],
  [/\bbalkon|\bbalcony/, "balcony"],
  [/\btaras|\bterrace/, "terrace"],
  [/\bogrod|\bogrodek|\bgarden/, "garden"],
  [/\bklimatyzacj|\bair con|\bac\b/, "air_conditioning"],
  [/\bkuchni\w* (osobn|oddzieln|zamknie)|\bseparate kitchen/, "separate_kitchen"],
  [/\bdo wprowadzenia|\bgotowe do zamieszkania|\bready to move/, "ready_to_move_in"],
  [/\bstan deweloperski|\bdeveloper standard/, "developer_standard"],
  [/\bdo remontu|\bdo odswiezenia|\bneeds renovation|\bfixer/, "needs_renovation"],
];

export function parseIntentLocally(message: string, meta: OffersMeta): ChatIntent {
  const text = fold(message);
  const intent: ChatIntent = {};

  // --- area ----------------------------------------------------------------
  // Parsed first, and blanked out afterwards, so "40m" is never mistaken for money below.
  let rest = text;
  const areaMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|mkw|metr\w*|m\b)/);
  if (areaMatch) {
    const value = toNumber(areaMatch[1]);
    if (value != null && value >= 5 && value <= 1000) {
      const before = text.slice(Math.max(0, areaMatch.index! - 24), areaMatch.index!);
      if (MIN_WORDS.test(before)) intent.areaMin = value;
      else if (/\b(do|max|maks\w*|under|up to|below|ponizej)\b/.test(before)) intent.areaMax = value;
      else intent.areaAround = value;
    }
    rest = text.slice(0, areaMatch.index) + " ".repeat(areaMatch[0].length) + text.slice(areaMatch.index! + areaMatch[0].length);
  }

  // --- budget --------------------------------------------------------------
  const money =
    rest.match(/(\d[\d\s.,]*)\s*(mln|milion\w*|million\w*)/) ??
    rest.match(/(\d[\d\s.,]*)\s*(tys\w*|thousand|k)\b/) ??
    rest.match(/(\d[\d\s.,]*)\s*(zl|pln)\b/) ??
    rest.match(/\b(\d{5,})\b/);
  if (money) {
    const base = toNumber(money[1]);
    const unit = money[2] ?? "";
    const multiplier = /mln|milion|million/.test(unit) ? 1_000_000 : /tys|thousand|^k$/.test(unit) ? 1_000 : 1;
    const value = base != null ? base * multiplier : null;
    if (value != null && value >= 1_000 && value <= 100_000_000) {
      const before = rest.slice(Math.max(0, money.index! - 24), money.index!);
      if (MIN_WORDS.test(before)) intent.budgetMin = value;
      else intent.budgetMax = value;
    }
  }

  // --- rooms ---------------------------------------------------------------
  if (/\bkawalerk|\bstudio\b/.test(text)) {
    intent.rooms = [1];
  } else {
    const rooms = [...text.matchAll(/\b(\d)\s*[-\s]?\s*(?:pokoj\w*|pok\b|rooms?\b|bedrooms?\b)/g)]
      .map((match) => Number(match[1]))
      .filter((value) => value >= 1 && value <= 20);
    // "2 lub 3 pokoje" states the room count once but means both.
    const alternative = text.match(/\b(\d)\s*(?:lub|albo|\/|or)\s*(\d)\s*(?:pokoj\w*|pok\b|rooms?\b)/);
    if (alternative) rooms.push(Number(alternative[1]), Number(alternative[2]));
    if (rooms.length) intent.rooms = [...new Set(rooms)].filter((value) => value >= 1 && value <= 20);
    else if (ROOM_WORDS.test(text)) {
      const word = text.match(/\b(dwu|trzy|czter\w*|jedno|pieci\w*)(?:pokojow\w*)?/);
      const map: Record<string, number> = { jedno: 1, dwu: 2, trzy: 3, czter: 4, pieci: 5 };
      const key = word ? Object.keys(map).find((prefix) => word[1].startsWith(prefix)) : undefined;
      if (key) intent.rooms = [map[key]];
    }
  }

  // --- ordering ------------------------------------------------------------
  // Checked before "cheap", because a superlative is an ordering and must not also trip the
  // median cut-off: "najtańsze" means the cheapest of everything, not the cheapest of the cheap.
  if (/\bnajdro\w*|\bnajwyzsz\w*\s*cen|\bmost expensive|\bhighest price|\bod najdro\w*/.test(text)) {
    intent.sort = "price_desc";
  } else if (/\bnajtan\w*|\bnajnizsz\w*\s*cen|\bcheapest|\blowest price|\bod najtan\w*/.test(text)) {
    intent.sort = "price_asc";
  } else if (/\bnajnowsz\w*|\bnewest|\blatest|\bostatnio dodan\w*|\brecently added/.test(text)) {
    intent.sort = "newest";
  } else if (/\bza metr|\bper m2|\bper square|\bbest value|\bnajlepsza cena za/.test(text)) {
    intent.sort = "price_per_m2_asc";
  }

  // --- cheap ---------------------------------------------------------------
  // Only price_asc blocks it: "tanie mieszkania, pokaż najtańsze" must not apply the median
  // cut-off and then sort inside it. Any other ordering combines with "cheap" perfectly well.
  if (intent.sort !== "price_asc" && /\btani\w*|\btanie\b|\bniedrog\w*|\bcheap|\baffordable|\bbudget\b|\bokazj\w*|\bbargain/.test(text)) {
    intent.cheap = true;
  }

  // --- market --------------------------------------------------------------
  if (/\bnowe\b|\bnowa\b|\bdeweloper\w*|\bpierwotn\w*|\bnew build|\bprimary\b|\bbrand new/.test(text)) {
    intent.market = "PRIMARY";
  } else if (/\bwtorn\w*|\buzywan\w*|\bz drugiej reki|\bresale|\bsecondary\b/.test(text)) {
    intent.market = "SECONDARY";
  }

  // --- features ------------------------------------------------------------
  const features = FEATURE_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, feature]) => feature);
  if (features.length) intent.features = [...new Set(features)];

  // --- district ------------------------------------------------------------
  // Read off the districts that actually exist rather than a hardcoded list, so the parser stays
  // correct if the dataset changes. Only the distinctive word of a name is matched: "Przymorze
  // Wielkie" is found by "przymorze", never by "wielkie", which is an ordinary Polish adjective
  // and would fire on "wielkie mieszkanie".
  for (const name of districtKeywords(meta)) {
    if (text.includes(name.stem)) {
      const matches = matchDistricts(name.token, meta);
      if (matches.length) {
        intent.district = name.token;
        break;
      }
    }
  }

  return intent;
}

/** Words too generic to identify a district on their own. */
const DISTRICT_STOPWORDS = new Set(["gorny", "gorna", "dolny", "dolna", "wielkie", "male", "gdansk", "poludnie", "swiety"]);

interface DistrictKeyword {
  /** The distinctive word, in the form matchDistricts() should be given. */
  token: string;
  /** That word minus its last character, to survive Polish case endings ("Wrzeszczu"). */
  stem: string;
}

/** Longest names first, so "Orunia Górna" is tried before a shorter name it contains. */
function districtKeywords(meta: OffersMeta): DistrictKeyword[] {
  const keywords: DistrictKeyword[] = [];
  const seen = new Set<string>();
  for (const district of meta.districts) {
    for (const word of fold(district.name).split(/[^a-z0-9]+/)) {
      if (word.length < 5 || DISTRICT_STOPWORDS.has(word) || seen.has(word)) continue;
      seen.add(word);
      keywords.push({ token: word, stem: word.slice(0, -1) });
    }
  }
  return keywords.sort((a, b) => b.token.length - a.token.length);
}
