import Link from "next/link";

/** Page links carry every other filter along, so paging never silently drops the query. */
export default function Pagination({
  page,
  pageSize,
  total,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  params: URLSearchParams;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (lastPage <= 1) return null;

  const hrefFor = (target: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(target));
    return `/?${next}`;
  };

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 py-6" aria-label="Pagination">
      <p className="text-sm text-neutral-600 tabular-nums">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">
            Previous
          </Link>
        ) : (
          <span className="rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-400">Previous</span>
        )}
        <span className="text-sm text-neutral-600 tabular-nums">
          Page {page} of {lastPage}
        </span>
        {page < lastPage ? (
          <Link href={hrefFor(page + 1)} className="rounded border border-neutral-300 px-3 py-1.5 text-sm">
            Next
          </Link>
        ) : (
          <span className="rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-400">Next</span>
        )}
      </div>
    </nav>
  );
}
