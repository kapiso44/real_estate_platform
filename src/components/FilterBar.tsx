"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { OffersMeta } from "@/lib/offers";
import type { OfferFilters } from "@/lib/search";
import { featureLabel } from "@/lib/format";

/**
 * Filters live in the URL and nowhere else: the form writes query parameters and the server
 * component re-renders from them. That keeps a filtered result refreshable and shareable, and
 * leaves exactly one definition of what a filter means (searchOffers on the server).
 */
export default function FilterBar({ meta, filters }: { meta: OffersMeta; filters: OfferFilters }) {
  const router = useRouter();
  const [features, setFeatures] = useState<string[]>(filters.features ?? []);

  function apply(form: HTMLFormElement) {
    const data = new FormData(form);
    const params = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      const text = String(value).trim();
      if (text) params.append(key, text);
    }
    for (const feature of features) params.append("features", feature);
    router.push(params.size ? `/?${params}` : "/");
  }

  const topFeatures = meta.features.slice(0, 8).map((entry) => entry.feature);

  return (
    <form
      className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        apply(event.currentTarget);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-sm lg:col-span-2">
          <span className="text-neutral-600">Search</span>
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="e.g. Wrzeszcz, balcony, sea view"
            className="rounded border border-neutral-300 px-3 py-2"
          />
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-neutral-600">District</span>
          <select
            name="districts"
            defaultValue={filters.districts?.[0] ?? ""}
            className="rounded border border-neutral-300 px-3 py-2"
          >
            <option value="">Any district</option>
            {meta.districts.map((district) => (
              <option key={district.name} value={district.name}>
                {district.name} ({district.count})
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-neutral-600">Market</span>
          <select name="market" defaultValue={filters.market ?? ""} className="rounded border border-neutral-300 px-3 py-2">
            <option value="">Any</option>
            <option value="PRIMARY">New build</option>
            <option value="SECONDARY">Resale</option>
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <fieldset className="grid gap-1 text-sm">
          <legend className="text-neutral-600">Area (m²)</legend>
          <div className="flex gap-2">
            <input name="areaMin" type="number" min={0} defaultValue={filters.areaMin ?? ""} placeholder="from" className="w-full rounded border border-neutral-300 px-3 py-2" />
            <input name="areaMax" type="number" min={0} defaultValue={filters.areaMax ?? ""} placeholder="to" className="w-full rounded border border-neutral-300 px-3 py-2" />
          </div>
        </fieldset>

        <fieldset className="grid gap-1 text-sm">
          <legend className="text-neutral-600">Price (PLN)</legend>
          <div className="flex gap-2">
            <input name="priceMin" type="number" min={0} step={10000} defaultValue={filters.priceMin ?? ""} placeholder="from" className="w-full rounded border border-neutral-300 px-3 py-2" />
            <input name="priceMax" type="number" min={0} step={10000} defaultValue={filters.priceMax ?? ""} placeholder="to" className="w-full rounded border border-neutral-300 px-3 py-2" />
          </div>
        </fieldset>

        <label className="grid gap-1 text-sm">
          <span className="text-neutral-600">Rooms</span>
          <select name="rooms" defaultValue={filters.rooms?.[0]?.toString() ?? ""} className="rounded border border-neutral-300 px-3 py-2">
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((count) => (
              <option key={count} value={count}>
                {count === 5 ? "5+" : count}
              </option>
            ))}
          </select>
        </label>

        <label className="grid gap-1 text-sm">
          <span className="text-neutral-600">Sort by</span>
          <select name="sort" defaultValue={filters.sort} className="rounded border border-neutral-300 px-3 py-2">
            <option value="relevance">Relevance</option>
            <option value="price_asc">Price, lowest first</option>
            <option value="price_desc">Price, highest first</option>
            <option value="price_per_m2_asc">Price per m², lowest first</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>

      {topFeatures.length > 0 && (
        <fieldset className="grid gap-2 text-sm">
          <legend className="text-neutral-600">Features</legend>
          <div className="flex flex-wrap gap-2">
            {topFeatures.map((feature) => {
              const active = features.includes(feature);
              return (
                <button
                  type="button"
                  key={feature}
                  onClick={() => setFeatures(active ? features.filter((f) => f !== feature) : [...features, feature])}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    active ? "border-blue-700 bg-blue-700 text-white" : "border-neutral-300 bg-white text-neutral-700"
                  }`}
                  aria-pressed={active}
                >
                  {featureLabel(feature)}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="flex gap-2">
        <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
          Apply filters
        </button>
        <button
          type="button"
          onClick={() => {
            setFeatures([]);
            router.push("/");
          }}
          className="rounded border border-neutral-300 px-4 py-2 text-sm"
        >
          Reset
        </button>
      </div>
    </form>
  );
}
