# Smart Real Estate Listings

Browse, filter and search 100 flats for sale in Gdańsk, scraped from Otodom, normalized into a
queryable shape, and searchable either with ordinary filters or by typing a sentence.

Next.js 16 (App Router, TypeScript) · MySQL 8 + Drizzle · Google Gemini for the chat box.

## Run it

Needs Docker and Node 24+. Four commands from a fresh clone:

```bash
npm install
npm run db:up      # MySQL 8 in Docker, host port 3307
npm run setup      # migrations + import + normalization
npm run dev        # http://localhost:3000
```

`npm run setup` is repeatable: it re-imports `data/raw/otodom-offers.json` and recomputes the
normalized layer from scratch. **No scraping and no network access is needed** - the raw data and
the AI enrichment results are committed to the repo.

### The API key is optional

Copy `.env.example` to `.env`. `DATABASE_URL` is already correct for the Docker setup.
`GEMINI_API_KEY` is the only thing you might add, and only the chat box uses it:

```
GEMINI_API_KEY=            # from https://aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.6-flash
```

Leave it empty and everything still works. The chat box falls back to a built-in Polish/English
parser and says so in the UI. Import, normalization and every other feature never touch an LLM.

## What is where

| Path | What it does |
|---|---|
| `scripts/scrape-otodom.ts` | Fetches listings. Already run; output committed to `data/raw/` |
| `scripts/normalize.ts` | `offers_raw` → `offers`: parsing, validation, quality flags, dedup |
| `scripts/report.ts` | Data quality report - the numbers quoted in `docs/REASONING.md` |
| `src/lib/search.ts` | **The only code that knows how to search.** Used by the page, the API and the chat |
| `src/lib/chat/` | Sentence → intent (LLM) → filters (business rules). See `rules.ts` for what "cheap" means |
| `src/app/` | Listing page, offer page, route handlers |

The pages read the database directly through `searchOffers`, not through their own HTTP API.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/offers` | Search. Same filters as the UI: `q`, `districts`, `rooms`, `priceMin/Max`, `areaMin/Max`, `pricePerM2Max`, `market`, `features`, `sort`, `page` |
| `GET /api/offers/:id` | One offer with photos, quality flags, price notes, provenance and duplicates |
| `GET /api/meta` | Districts, ranges and medians - the numbers the UI and the chat rules use |
| `POST /api/chat` | `{ "message": "..." }` → filters and a query string. Does not run the search itself |
| `GET /api/health` | Database connectivity |

```bash
curl -s "localhost:3000/api/offers?areaMin=40&areaMax=80&sort=price_per_m2_asc" | jq '.total'
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"tanie 2 pokoje we Wrzeszczu do 600 tys"}' | jq
```

## Documents

- `docs/REASONING.md` - why the data looks like this, where AI was and was not used, what broke
- `docs/SCENARIOS.md` - two user journeys with the exact URLs and the numbers they return

## Other commands

```bash
npm run db:report     # data quality report
npm run typecheck
npm run build
npm run db:down       # stop the database
```
