# Reasoning

100 flats for sale in Gdańsk, scraped from Otodom, normalized into a queryable shape, searchable
by filters or by typing a sentence. Every number below comes from `npm run db:report`.

## What data, and why

One city, one transaction type, 100 listings. Breadth would have proven nothing that depth does
not; the interesting problems are in the data, not in its volume.

Fields were chosen to answer the three questions a buyer actually asks — **what does it cost,
where is it, what is it** — so: price, price per m², area, rooms, floor, district, street, market,
year built, building type, features, photos, coordinates, description. Price per m² is stored
rather than computed on the fly because it is the only number that makes two listings comparable,
and it is what "cheap" is resolved against later.

Deliberately **not** extracted: phone numbers and contact names. They are personal data, they are
of no use to a buyer browsing listings, and once in a repo they cannot be taken back.

## Handling unstructured and low-quality data

Two layers. `offers_raw` keeps each record exactly as fetched; `offers` holds the normalized
result. Normalization is a pure function of the raw layer, so it can be re-run and corrected
without scraping again — `npm run setup` rebuilds everything offline.

Three rules carry most of the weight:

**A missing value is `NULL`, never `0` or `""`.** The UI renders it as "no data". 34 listings have
no street, 15 no year built, 6 no floor. Agencies withhold the street on purpose, so it is never
reverse-engineered from the description — an inferred address is worse than an honest gap.

**The structured field wins over the title, and the conflict is recorded rather than resolved
silently.** 5 listings advertise a different room count in the title than in their own data
(68416919 says "3 pokoje" with `rooms = TWO`). Both values stay, and a `rooms_title_mismatch`
flag is shown on the offer page. 58 of 100 listings carry at least one quality flag; all of them
are visible to the user in plain English, because a listing the data is unsure about is exactly
the one a buyer should look at twice.

**Duplicates are grouped, not deleted.** 4 groups, 8 listings — developers post the same flat
twice with prices differing by tens of złoty (716,809 vs 716,780 for 65.55 vs 65.52 m²). One is
marked canonical and shown; the sibling is linked from the offer page. Different floors would mean
different flats, so identity is never assumed from price and area alone. 27 listings share a
description with another listing (developer templates), detected by content hash and flagged.

Prices are never recalculated. Where the description changes what the price means, the fact is
attached as a quoted note: listing 68419629 advertises 478,000 PLN, and the page shows *"Zakup
miejsca postojowego jest obligatoryjny"* with its 35,000 PLN — a real entry price of 513,000.
95 such notes across 62 listings.

## Where AI was used — and where it was not

**Offline, at import time.** Reading 100 free-text descriptions for things the structured fields
do not carry: a one-line summary (100), price notes with the sentence that justifies them (95),
features stated in prose but absent from the checkbox list (51), one year built. Every inferred
value stores its source and quote in `field_sources`, so any claim can be traced back to the
sentence it came from. The results are committed, so import needs no key and no network.

**At runtime, in one place only: the chat box.** The model reads a sentence and returns intent as
JSON constrained by a response schema. It never sees the database, the schema or a query.

**Everything else is code.** The model does not compute prices, does not sort, does not generate
SQL. "Cheap" arrives as a boolean flag and is resolved in `src/lib/chat/rules.ts` against the
median price per m² of the district in play — per m², not total, or "cheap" would just mean
"small". "Around 40 m²" widens to 34–46 because a stated size is an intent, not a threshold. Every
rule that fires is displayed with the number it used, so the user can disagree with it.

This split is the whole design. A prompt cannot inject SQL, the same sentence gives the same
filters twice, and the model cannot produce an authoritative-looking number that is not in the
data. It also means the product degrades instead of breaking: with no API key, a deterministic
Polish/English parser feeds the identical rules.

## One key assumption

**The structured field is right and the title is marketing.** Where they disagree, the structured
value is used and the conflict is flagged. This holds for room counts and areas here, but it is an
assumption about Otodom's sellers, not a law — a bigger title number often counts a balcony that
the usable-area field correctly excludes.

## One success metric

**The share of searches that return at least one relevant listing without the user having to
correct the filters by hand.** It measures the thing this product actually claims: that a vague
sentence becomes a good query. A supporting input metric: price, area and district are present on
100% of listings, so no search can fail for lack of the fields it filters on.

## One failure mode

**"Cheap" is only as good as the median behind it.** Some districts hold one or two listings, and
a median of two numbers is not a market rate. The cut-off would be quietly wrong, and a quietly
wrong filter hides listings the user never learns existed. Mitigated rather than solved: the
number and its source are shown in the UI, and with several districts in play the city-wide median
is used instead of picking one. The real fix is more data.

Second-order: the full-text search truncates Polish word endings instead of stemming properly, so
it over-matches on short stems and leans on relevance ranking to keep the best hits on top.

## With more time

Multi-turn chat, so "and with a balcony?" refines the previous search instead of starting over.
A map, since the coordinates are already stored. Price history, which needs repeated scraping over
time and is where "is this a good deal" stops being a guess. A proper Polish stemmer. And a larger
sample, which would fix the median problem directly.

---

## How this was verified

Each stage ended with a report listing its acceptance criteria, each with the command that checks
it and that command's output. **Verification was done by a human against a running system, not
asserted by the model** — the sort bug below was found exactly that way.

- `npm run db:report` — deterministic by design (no timestamps), so two normalization runs can be
  compared byte for byte.
- Chat output cross-checked against the API: the query string a sentence produces is pasted into
  `/api/offers` and must return the same listings the page shows.
- `pricePerM2Max` from the chat compared against `/api/meta` — it must equal the median exactly,
  proving the number came from the data and not from the model.
- The same intent in Polish and English must produce a byte-identical query string.
- The whole app re-tested with `GEMINI_API_KEY=` empty.
- `npm run typecheck` and `npm run build` clean.

## Problems hit along the way

| Problem | Resolution |
|---|---|
| Plain `curl` got `403` from CloudFront | The listing data is JSON embedded in the page, so no HTML parsing was needed once the request looked like a browser |
| `WHERE city = 'Gdańsk'` returned 0 rows against correct data | The `mysql` CLI connects as latin1 by default. A client trap, not a data bug — `--default-character-set=utf8mb4` |
| MySQL has no Polish stemmer, so "Wrzeszczu" missed "Wrzeszcz" | Truncate word endings before the wildcard. Measured: "Wrzeszczu" 3→21 matches, "balkonem" 7→61 (`src/lib/search.ts:71`) |
| `features` mixed Otodom slugs with the AI vocabulary — `lift` beside `elevator` | One canonical vocabulary at normalization time (`scripts/normalize.ts:90`); raw slugs untouched in `offers_raw` |
| `gemini-2.5-flash` returned `404 no longer available to new users` | Moved to `gemini-3.6-flash` |
| Gemini free tier hit `429 exceeded your current quota` mid-testing | Nothing broke: the app fell through to the local parser and kept answering. The best evidence the fallback earns its place |
| "Pokaż najdroższe mieszkanie" was not understood | `ChatIntent` had no `sort` field, so the response schema physically forbade the model from expressing it. A superlative is an ordering, not a filter — a category the design had missed. **Found by the author during acceptance testing** |
| The model invented a "Kraków" requirement that the brief does not contain | Caught in review and corrected before it reached the scraper. Worth recording: the AI-writes / human-verifies loop is what caught it |
| An API key was pasted into a session prompt and written to a local log | Redacted before any commit and confirmed absent from every branch with `git log --all -S`; the key itself is treated as compromised and replaced |
