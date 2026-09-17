import Link from "next/link";
import { notFound } from "next/navigation";
import { getOfferById } from "@/lib/offers";
import {
  NO_DATA,
  featureLabel,
  flagLabel,
  formatArea,
  formatDate,
  formatFloor,
  formatMarket,
  formatPrice,
  formatPricePerM2,
  formatRooms,
  formatYear,
  priceNoteLabel,
  sourceLabel,
} from "@/lib/format";

export const dynamic = "force-dynamic";

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  const missing = value === NO_DATA;
  return (
    <div className="border-b border-neutral-100 py-2">
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className={missing ? "text-sm text-neutral-400 italic" : "text-sm text-neutral-900"}>
        {value}
        {note && <span className="ml-2 text-xs font-normal text-blue-700">({note})</span>}
      </dd>
    </div>
  );
}

export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const offerId = Number(id);
  if (!Number.isInteger(offerId) || offerId <= 0) notFound();

  const offer = await getOfferById(offerId);
  if (!offer) notFound();

  const provenance = (field: string) => {
    const entry = offer.fieldSources[field];
    return entry ? sourceLabel(entry.source) : undefined;
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/" className="text-sm text-blue-700 hover:underline">
        ← Back to listings
      </Link>

      <h1 className="mt-4 text-2xl font-semibold">{offer.title}</h1>
      <p className="mt-1 text-sm text-neutral-600">
        {offer.district ?? NO_DATA} · {offer.city} · {formatMarket(offer.market)}
      </p>

      {offer.photos.length > 0 ? (
        <>
          <div className="mt-6 overflow-hidden rounded-lg bg-neutral-100">
            <img src={offer.photos[0]} alt="" referrerPolicy="no-referrer" className="h-auto w-full object-cover" />
          </div>
          {offer.photos.length > 1 && (
            <div className="mt-2 flex gap-2 overflow-x-auto pb-2">
              {offer.photos.slice(1, 12).map((photo) => (
                <img
                  key={photo}
                  src={photo}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-20 w-28 flex-none rounded object-cover"
                />
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-neutral-500">
            {offer.photos.length} photos collected
            {offer.photosDeclared != null && ` · ${offer.photosDeclared} declared by the listing`}
          </p>
        </>
      ) : (
        <p className="mt-6 rounded border border-neutral-200 bg-white px-4 py-8 text-center text-sm text-neutral-500">
          This listing has no photos.
        </p>
      )}

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-2xl font-semibold tabular-nums">{formatPrice(offer.price)}</p>
        <p className="text-sm text-neutral-600 tabular-nums">{formatPricePerM2(offer.pricePerM2)}</p>
      </section>

      {offer.priceNotes.length > 0 && (
        <section className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">What the price does not include</h2>
          <ul className="mt-2 grid gap-3">
            {offer.priceNotes.map((note, index) => (
              <li key={index} className="text-sm text-amber-900">
                <strong>{priceNoteLabel(note.type)}</strong>
                {note.amountPln != null && <> — {formatPrice(note.amountPln)}</>}
                <blockquote className="mt-1 border-l-2 border-amber-400 pl-3 text-xs italic text-amber-800">
                  “{note.quote}”
                </blockquote>
              </li>
            ))}
          </ul>
        </section>
      )}

      {offer.aiSummary && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Summary
            <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs font-normal text-neutral-700">AI-generated</span>
          </h2>
          <p className="mt-2 text-sm text-neutral-800">{offer.aiSummary}</p>
        </section>
      )}

      <section className="mt-4 grid gap-x-8 rounded-lg border border-neutral-200 bg-white p-4 sm:grid-cols-2">
        <dl>
          <Field label="Area" value={formatArea(offer.areaM2)} />
          <Field label="Rooms" value={formatRooms(offer.rooms)} />
          <Field label="Floor" value={formatFloor(offer.floorNum, offer.floorLabel)} note={provenance("floor")} />
          <Field label="Floors in building" value={offer.floorsTotal == null ? NO_DATA : String(offer.floorsTotal)} />
          <Field label="Build year" value={formatYear(offer.yearBuilt)} note={provenance("year_built")} />
          <Field label="Monthly fee" value={formatPrice(offer.rent)} />
        </dl>
        <dl>
          <Field label="Street" value={offer.street ?? NO_DATA} note={provenance("street")} />
          <Field label="Building" value={offer.buildingType ?? NO_DATA} />
          <Field label="Ownership" value={offer.buildingOwnership ?? NO_DATA} />
          <Field label="Condition" value={offer.constructionStatus ?? NO_DATA} />
          <Field label="Heating" value={offer.heating ?? NO_DATA} />
          <Field label="Listed by" value={offer.sellerName ?? (offer.advertiserType === "PRIVATE" ? "Private seller" : NO_DATA)} />
        </dl>
      </section>

      {offer.features.length > 0 && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Features</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {offer.features.map((feature) => (
              <li key={feature} className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700">
                {featureLabel(feature)}
              </li>
            ))}
          </ul>
          {offer.fieldSources.features && (
            <p className="mt-2 text-xs text-neutral-500">
              Some features were {sourceLabel(offer.fieldSources.features.source)}.
            </p>
          )}
        </section>
      )}

      {offer.qualityFlags.length > 0 && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Data quality notes</h2>
          <ul className="mt-2 grid gap-1 text-sm text-neutral-700">
            {offer.qualityFlags.map((flag) => (
              <li key={flag}>• {flagLabel(flag)}</li>
            ))}
          </ul>
        </section>
      )}

      {offer.duplicates.length > 0 && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Near-identical listings</h2>
          <p className="mt-1 text-xs text-neutral-600">
            Same room count and floor, area within 0.5%, price within 1%, and the same building - most likely the same
            flat advertised more than once.
          </p>
          <ul className="mt-2 grid gap-1 text-sm">
            {offer.duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                <Link href={`/offers/${duplicate.id}`} className="text-blue-700 hover:underline">
                  {formatPrice(duplicate.price)} · {formatArea(duplicate.areaM2)} · {duplicate.district ?? NO_DATA}
                </Link>
                {duplicate.isCanonical && <span className="ml-2 text-xs text-neutral-500">(shown in search)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {offer.descriptionClean && (
        <section className="mt-4 rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Description</h2>
          {offer.qualityFlags.includes("template_description") && (
            <p className="mt-1 text-xs text-amber-700">
              This text is shared with other listings from the same development, so it may describe the project rather
              than this flat.
            </p>
          )}
          <p className="mt-2 whitespace-pre-line text-sm text-neutral-800">{offer.descriptionClean}</p>
        </section>
      )}

      <footer className="mt-6 flex flex-wrap items-center gap-4 border-t border-neutral-200 pt-4 text-sm">
        <a
          href={offer.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-blue-700 hover:underline"
        >
          See the original listing on Otodom →
        </a>
        <span className="text-neutral-500">Published {formatDate(offer.publishedAt)}</span>
      </footer>
    </main>
  );
}
