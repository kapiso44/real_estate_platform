import Link from "next/link";
import type { OfferListItem } from "@/lib/search";
import { featureLabel, formatArea, formatFloor, formatPrice, formatPricePerM2, formatRooms } from "@/lib/format";

/**
 * Photos are hotlinked straight from Otodom's CDN with a plain <img>: next/image would proxy
 * every file through the optimizer, which adds latency and a failure mode for no benefit here.
 */
export default function OfferCard({ offer }: { offer: OfferListItem }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <Link href={`/offers/${offer.id}`} className="relative block aspect-[4/3] bg-neutral-100">
        {offer.photo ? (
          <img
            src={offer.photo}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-sm text-neutral-500">no photo</span>
        )}
        {offer.priceNotes.length > 0 && (
          <span className="absolute left-2 top-2 rounded bg-amber-600 px-2 py-0.5 text-xs font-medium text-white">
            price has conditions
          </span>
        )}
      </Link>

      <div className="flex flex-1 flex-col gap-1 p-4">
        <p className="text-lg font-semibold tabular-nums">{formatPrice(offer.price)}</p>
        <p className="text-sm text-neutral-500 tabular-nums">{formatPricePerM2(offer.pricePerM2)}</p>
        <p className="text-sm text-neutral-700">
          {formatArea(offer.areaM2)} · {formatRooms(offer.rooms)} · {formatFloor(offer.floorNum, offer.floorLabel)}
        </p>
        <p className="text-sm text-neutral-500">{offer.district ?? offer.title}</p>

        <h2 className="mt-1 line-clamp-2 text-sm font-medium text-neutral-900">
          <Link href={`/offers/${offer.id}`}>{offer.title}</Link>
        </h2>

        {offer.features.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1">
            {offer.features.slice(0, 4).map((feature) => (
              <li key={feature} className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
                {featureLabel(feature)}
              </li>
            ))}
          </ul>
        )}

        <Link
          href={`/offers/${offer.id}`}
          className="mt-auto pt-3 text-sm font-medium text-blue-700 hover:underline"
        >
          See details →
        </Link>
      </div>
    </article>
  );
}
