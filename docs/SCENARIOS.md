# Example scenarios

Two user journeys, with the exact URL for each step and the number of listings it returns.
Every number below was taken from a running instance, not estimated.

> **One deviation from the brief.** The brief illustrates scenario A with "Kraków, 40–80 m²".
> This dataset is Gdańsk: the brief asks for one city and names Kraków only as an example of the
> shape of the journey, so the city was chosen once and kept. The journey is identical; only the
> place name differs. 44 listings fall in the 40–80 m² band, so the scenario shows real results.

---

## Scenario A — filters: a flat in Gdańsk, 40–80 m²

**Who.** Someone with a budget and a rough idea of size, who does not want to read 100 listings.

| Step | What the user does | URL | Result |
|---|---|---|---|
| 1 | Opens the listing | `/` | 96 listings |
| 2 | Sets 40–80 m² | `/?areaMin=40&areaMax=80` | **44 listings** |
| 3 | Caps the budget at 700,000 PLN | `/?areaMin=40&areaMax=80&priceMax=700000` | **21 listings** |
| 4 | Sorts by price per m² | `…&sort=price_per_m2_asc` | Best value first: **370,000 PLN, 46.4 m², 7,974 PLN/m²**, Rudniki |
| 5 | Opens the offer | `/offers/68416050` | Photos, features, quality flags, AI summary, link to the original |

```bash
curl -s "localhost:3000/api/offers?areaMin=40&areaMax=80" | jq '.total'                  # 44
curl -s "localhost:3000/api/offers?areaMin=40&areaMax=80&priceMax=700000" | jq '.total'  # 21
```

**Why 44 and not 46.** The raw data has 46 listings in that band; two of them are duplicate
postings of flats already in the list. Duplicates are grouped, not deleted - the offer page shows
the near-identical sibling and links to it. Ask for them explicitly and you get 46 back:

```bash
curl -s "localhost:3000/api/offers?areaMin=40&areaMax=80&includeDuplicates=true" | jq '.total'  # 46
```

**What the offer page adds.** Listing 68419629 advertises 478,000 PLN. The page also shows, quoted
from the description: *"Do mieszkania przynależy miejsce postojowe w cenie 35 000 zł"* and
*"Zakup miejsca postojowego jest obligatoryjny"*. The real entry price is 513,000 PLN. The
advertised number is never silently rewritten - the note is shown next to it with the sentence
that justifies it. The same page flags that the source put `420` in the street field, so the
street reads "no data" rather than a house number pretending to be an address.

---

## Scenario B — chat box: a vague intent

**Who.** Someone who would type what they want into a search bar and hope for the best.

### Input

```
tanie 2 pokoje we Wrzeszczu do 600 tys
```

### What the user sees

```
Understood as:
  • District: Wrzeszcz Dolny
  • Budget: up to 600,000 PLN
  • "Cheap" = below the Wrzeszcz Dolny median of PLN 14,001/m²
  • Rooms: 2

2 listings found
  520,000 PLN · 37.14 m² · 2 rooms · Wrzeszcz Dolny
  389,658 PLN · 33.55 m² · 2 rooms · Wrzeszcz Dolny
```

The URL becomes
`/?districts=Wrzeszcz+Dolny&rooms=2&priceMax=600000&pricePerM2Max=14001.08` - a normal, shareable,
refreshable filtered search. The chat renders no results of its own; the listing below re-renders
from the URL, exactly as if the filters had been typed into the filter bar.

**The point of the third line.** The user never said a number for "cheap". The model did not
invent one either - it returned `cheap: true` and nothing else. The 14,001 PLN/m² is the median
price per m² of Wrzeszcz Dolny, computed from the data in `src/lib/offers.ts`, and it is shown so
the user can disagree with it and widen the filter by hand.

### The same thing in English

```
cheap 2 rooms in Wrzeszcz up to 600k
```

produces a byte-identical query string. Both languages go through the same rules.

### Other sentences that work

| Input | Resulting filters |
|---|---|
| `Pokaż najdroższe mieszkanie w Gdańsku` | `sort=price_desc` - 4,489,000 PLN first |
| `cheapest studio under 450k` | `rooms=1&priceMax=450000&sort=price_asc` |
| `nowe mieszkanie z balkonem i windą na Przymorzu` | `districts=Przymorze Wielkie,Przymorze Małe&features=balcony,elevator&market=PRIMARY` → **0 listings** |
| `coś z widokiem na morze, około 60m` | `q=widok na morze&areaMin=51&areaMax=69` |
| `asdf qwerty` | Nothing understood; the app says so and changes nothing |

The zero is correct, not a bug: all 7 Przymorze listings in this dataset are resale. The page says
"Nothing matches these filters" instead of quietly dropping the constraint that caused it.

"Najtańsze" sorts by price ascending and deliberately does **not** apply the median cut-off -
otherwise the user would get the cheapest of the cheap rather than the cheapest overall.

### Without an API key

```bash
GEMINI_API_KEY= npm run dev
```

The same sentence returns the same query string, and the UI notes that the built-in parser was
used. The parser understands less than the model - it takes the first amount and the first size
in a sentence, so it cannot handle "between 400 and 600 thousand" - but the rules that turn intent
into filters are identical, so the demo never depends on a network call.
