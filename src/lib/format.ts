/**
 * Presentation helpers. The single rule they enforce: a missing value is shown as "no data",
 * never as an empty gap, "null" or "NaN". If the source did not say it, the page says so.
 */

export const NO_DATA = "no data";

export const orNoData = (value: unknown, render: (value: never) => string = String as never): string =>
  value === null || value === undefined || value === "" ? NO_DATA : render(value as never);

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "PLN", maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

export const formatPrice = (value: number | null | undefined): string =>
  value == null ? NO_DATA : money.format(value);

export const formatPricePerM2 = (value: number | null | undefined): string =>
  value == null ? NO_DATA : `${money.format(value)}/m²`;

export const formatArea = (value: number | null | undefined): string =>
  value == null ? NO_DATA : `${decimal.format(value)} m²`;

export const formatRooms = (value: number | null | undefined): string =>
  value == null ? NO_DATA : value === 1 ? "1 room" : `${value} rooms`;

const ordinal = (n: number): string => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
};

/** A floor may be a number, a label ("above tenth") or genuinely unknown - all three are shown honestly. */
export function formatFloor(floorNum: number | null | undefined, floorLabel?: string | null): string {
  if (floorNum === 0) return "Ground floor";
  if (typeof floorNum === "number") return `${ordinal(floorNum)} floor`;
  if (floorLabel === "above_tenth") return "Above 10th floor";
  if (floorLabel === "garret") return "Garret";
  if (floorLabel === "cellar") return "Cellar";
  return NO_DATA;
}

export const formatMarket = (value: string | null | undefined): string =>
  value === "PRIMARY" ? "New build" : value === "SECONDARY" ? "Resale" : NO_DATA;

export const formatDate = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : NO_DATA;

export const formatYear = (value: number | null | undefined): string => (value == null ? NO_DATA : String(value));

/** Turns a snake_case slug into a readable label, with explicit names for the canonical vocabulary. */
const FEATURE_LABELS: Record<string, string> = {
  elevator: "Elevator",
  parking: "Parking or garage",
  storage: "Storage room",
  security: "Secured building",
  appliances: "Kitchen appliances",
  furnished: "Furnished",
  balcony: "Balcony",
  terrace: "Terrace",
  garden: "Garden",
  air_conditioning: "Air conditioning",
  separate_kitchen: "Separate kitchen",
  ready_to_move_in: "Ready to move in",
  developer_standard: "Developer standard",
  needs_renovation: "Needs renovation",
};

export const featureLabel = (slug: string): string =>
  FEATURE_LABELS[slug] ?? slug.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Quality flags exist to be shown, not hidden - each one gets a plain-English explanation. */
const FLAG_LABELS: Record<string, string> = {
  rooms_title_mismatch: "The title advertises a different number of rooms than the structured data",
  street_missing: "The seller did not disclose the street",
  street_not_a_name: "The source street field held a house number, not a street name",
  template_description: "This description is reused across several listings (developer template)",
  year_built_missing: "Build year not provided",
  floor_missing: "Floor not provided",
  floor_not_numeric: "The source gives the floor only as a label, not a number",
  floor_above_building_height: "The stated floor was higher than the building, so it was dropped",
  photos_missing: "No photos in the listing",
  photos_more_than_declared: "More photos than the listing declared",
  duplicate_of_canonical: "A near-identical listing exists; this one is treated as the copy",
  description_missing: "No description",
  description_has_html: "The description still contains markup",
};

export const flagLabel = (flag: string): string =>
  FLAG_LABELS[flag] ?? flag.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Where a value came from when it was not taken verbatim from the search listing. */
export const sourceLabel = (source: string): string =>
  source === "ai_description"
    ? "inferred from the description by AI"
    : source === "detail_page"
      ? "taken from the offer page"
      : source;

const PRICE_NOTE_LABELS: Record<string, string> = {
  mandatory_parking: "Parking space is obligatory and priced separately",
  extra_cost: "Extra cost on top of the advertised price",
  vat_note: "VAT changes what the advertised price means",
  other: "Note about the price",
};

export const priceNoteLabel = (type: string): string => PRICE_NOTE_LABELS[type] ?? type;
