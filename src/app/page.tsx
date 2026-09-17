import FilterBar from "@/components/FilterBar";
import OfferCard from "@/components/OfferCard";
import Pagination from "@/components/Pagination";
import { getMeta } from "@/lib/offers";
import { parseFilters, searchOffers } from "@/lib/search";
import { formatPricePerM2 } from "@/lib/format";

export const dynamic = "force-dynamic";

/** In Next 16 searchParams arrives as a promise and is a plain object, not URLSearchParams. */
function toSearchParams(input: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = toSearchParams(await searchParams);

  // A hand-edited URL should not crash the page: fall back to defaults and say what happened.
  let filters;
  let invalidQuery = false;
  try {
    filters = parseFilters(query);
  } catch {
    filters = parseFilters(new URLSearchParams());
    invalidQuery = true;
  }

  const [result, meta] = await Promise.all([searchOffers(filters), getMeta()]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Flats for sale in {meta.city}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {meta.total} listings · median {formatPricePerM2(meta.medianPricePerM2)} · duplicates of the same flat are
          grouped and shown once
        </p>
      </header>

      <FilterBar meta={meta} filters={filters} />

      {invalidQuery && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Some search parameters in the link were not valid, so the default view is shown.
        </p>
      )}

      {result.textQueryRelaxed && (
        <p className="mt-4 rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          No listing matched every word of “{filters.q}”, so these results match any of them.
        </p>
      )}

      <p className="mt-6 text-sm text-neutral-600 tabular-nums">
        {result.total} {result.total === 1 ? "listing" : "listings"} found
      </p>

      {result.items.length === 0 ? (
        <p className="mt-6 rounded border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-600">
          Nothing matches these filters. Try widening the price or area range, or clearing the district.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((offer) => (
            <OfferCard key={offer.id} offer={offer} />
          ))}
        </div>
      )}

      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} params={query} />
    </main>
  );
}
