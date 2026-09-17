
---

## Zadanie

Napisz skrypt, który pobiera **~100 ogłoszeń mieszkań na sprzedaż z Otodom, z Gdańska** i
zapisuje je w formie gotowej do (a) dalszego przetwarzania/importu do MySQL,
(b) szybkiej wizualnej weryfikacji jakości danych okiem człowieka, ze zdjęciami
i linkiem do oryginalnego ogłoszenia dla każdej pozycji.

## Zasady dostępu (zweryfikowane — nie trzeba odkrywać na nowo)

- Zwykły `fetch`/`curl` z nagłówkiem `User-Agent` ustawionym na realistyczną
  przeglądarkę wystarcza:
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36`.
  Bez tego nagłówka serwer (CloudFront) zwraca 403. Nie są potrzebne `Accept`,
  `Accept-Language`, `Referer`, cookies ani sesja.
- Dodaj **opóźnienie 1–2 s między requestami** — grzeczność wobec serwera; przy
  tej skali (~200 requestów: listy + szczegóły) to i tak kwestia kilku minut.
- **Cachuj surowe odpowiedzi na dysku** (po ID oferty, np. `.cache/otodom/{id}.html`).
  Jeśli skrypt wywali się w połowie albo trzeba go poprawić, nie ściągaj
  wszystkiego od nowa — skrypt ma być idempotentny.
- Nie dotykaj ścieżek zablokowanych w `robots.txt`: `/ajax/`, `/hpr/`,
  `/api/query` (bez `?crawl=true`), `/drukuj/`, `/platnosze/` — i tak ich nie
  potrzebujesz.
- To scraper do prywatnego prototypu rekrutacyjnego, nie publikowanego jako
  produkt. Regulamin Otodom (pkt 2.3.b) formalnie zakazuje agregowania danych
  serwisu i dalszego udostępniania ich osobom trzecim — nie publikuj zebranego
  zbioru publicznie i nie buduj z niego żywego serwisu dla innych użytkowników.

## Źródło: jedno miasto — Gdańsk

Brief nie narzuca konkretnego miasta ani liczby miast — "Kraków, 40-80 m²" w
sekcji Example Scenarios to tylko ilustracyjny przykład formatu user journey w
szablonie briefu, nie wymóg co do danych. Wybrane źródło: **wyłącznie Gdańsk**,
~100 ofert z jednej lokalizacji. Prościej, szybciej w 6-godzinnym budżecie, i
zgodne z "not a scraping challenge - correctness and reasoning matter more
than scale".

Jeśli przykładowy user journey w dokumencie z uzasadnieniem ma referować
konkretne miasto/metraż, użyj Gdańska i realnego zakresu metraży, jaki
faktycznie wystąpi w zebranych danych (zweryfikuj po ściągnięciu, zamiast z
góry zakładać konkretny przedział).

URL strony wyników:
```
https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/pomorskie/gdansk/gdansk/gdansk?by=LATEST&direction=DESC&limit=72&page=<n>
```
`limit=72` działa i daje więcej ofert na stronę niż domyślne 36 (wartości typu
100/200 są po cichu ignorowane, wraca wtedy 36). Przy 72 ofertach na stronę
(minus 1 sztuczny duplikat, patrz niżej) dwie strony (`page=1`, `page=2`)
wystarczą, żeby zebrać ~100+ unikalnych ofert.

## Parsowanie strony wyników

1. Pobierz HTML, wyciągnij JSON z `<script id="__NEXT_DATA__" type="application/json">…</script>`.
2. Ścieżka do ofert: `props.pageProps.data.searchAds.items` (tablica).
3. **Pomiń ostatni element każdej strony** — to sztuczny duplikat pierwszej
   oferty ze strony, z 14-cyfrowym ID i linkiem zaczynającym się od `"hpr/"`
   (ścieżka zablokowana w robots.txt). Rozpoznaj po `href` zaczynającym się od
   `"hpr/"` albo po zdublowanym `slug`.
4. **Zbuduj link do oferty samodzielnie**: `https://www.otodom.pl/pl/oferta/{slug}`.
   Nie używaj pola `href` z listy — ma placeholder `[lang]`, to nie gotowy URL.
5. Pomiń rekordy z `estate !== "FLAT"` jako zabezpieczenie (przy poprawnym URL-u
   kategorii "mieszkanie" nie powinny się pojawić, ale sprawdź).

### Pola z listy (per oferta)

| Pole wyjściowe | Ścieżka w JSON |
|---|---|
| `id` | `id` |
| `slug` | `slug` |
| `title` | `title` |
| `price` + `currency` | `totalPrice.value`, `totalPrice.currency` |
| `pricePerSqm` | `pricePerSquareMeter.value` |
| `area` | `areaInSquareMeters` |
| `rooms` | `roomsNumber` (enum: ONE/TWO/THREE/…) |
| `floor` | `floorNumber` (enum: GROUND/FIRST/…) |
| `city` | `location.address.city.name` |
| `district` | ostatni element `location.reverseGeocoding.locations` z `locationLevel: "district"`, jeśli istnieje |
| `street` | `location.address.street.name` |
| `shortDescription` | `shortDescription` (uciętyd na ~200 znaków — traktuj jako WSTĘPNY, nie finalny opis) |
| `thumbnailImages` | `images[].large` (zwykle 2–3 URL-e) |
| `totalPossibleImages` | `totalPossibleImages` (deklarowana liczba zdjęć w ofercie) |
| `isPromoted` | `isPromoted` |
| `isPrivateOwner` | `isPrivateOwner` |
| `sellerName` | `advertOwner.name` albo `agency.name` |
| `sellerType` | `agency.type` (np. "AGENCY") albo `"PRIVATE"` jeśli `isPrivateOwner` |
| `dateCreated` | `dateCreated` |
| `offerUrl` | zbudowany jak w kroku 4 powyżej |

## Parsowanie strony pojedynczej oferty (dla każdej z ~100 zebranych ofert)

1. Pobierz `{offerUrl}`, wyciągnij ten sam `__NEXT_DATA__`.
2. Dane w `props.pageProps.ad`.

### Pola doszczegóławiające (nadpisują/uzupełniają dane z listy)

| Pole wyjściowe | Ścieżka w JSON |
|---|---|
| `market` | `ad.market` ("PRIMARY" / "SECONDARY") |
| `buildYear` | `ad.attributes.build_year` |
| `description` | `ad.description` — HTML; usuń tagi do czystego tekstu, zachowaj podział akapitów jako `\n\n` (przyda się do wykrywania "noisy descriptions") |
| `latitude`, `longitude` | `ad.location.coordinates.latitude/longitude` |
| `allImages` | `ad.images[].large` — pełna lista URL-i. **Nie pobieraj samych plików graficznych**, tylko zapisz adresy (oryginalny CDN Otodomu apollo.olxcdn.com) i hotlinkuj je w `<img src>` w prototypie |
| `buildingFloorsNum`, `buildingType`, `buildingOwnership`, `heating`, `windowsType` | `ad.attributes.*` |
| `equipmentTypes`, `extrasTypes`, `securityTypes` | `ad.attributes.*` (tablice) |
| `contactName` | `ad.contactDetails.name` |
| `contactPhone` | `ad.contactDetails.phones[0]` — **dane osobowe**: rozważ pominięcie albo zamaskowanie w publicznym/demo widoku prototypu |
| `modifiedAt` | `ad.modifiedAt` |

## Format wyjścia (żeby dało się łatwo obejrzeć i zweryfikować)

1. **`data/raw/otodom-offers.json`** — tablica ~100 płaskich obiektów (pola z
   listy scalone z polami ze szczegółów), gotowa do importu do MySQL / dalszego
   przetwarzania przez warstwę normalizacji.

2. **`data/raw/otodom-offers-preview.html`** — JEDNA statyczna strona HTML (bez
   frameworków, bez serwera — ma się otwierać podwójnym kliknięciem), pokazująca
   wszystkie zebrane oferty jako siatkę kart. Każda karta:
   - pierwsze zdjęcie jako `<img>` (hotlink do oryginalnego URL-a Otodom),
   - cena, metraż, liczba pokoi, miasto/dzielnica,
   - pierwsze ~150 znaków opisu,
   - **link `<a href="{offerUrl}" target="_blank">zobacz oryginalne ogłoszenie →</a>`**
     — wymagane: ma umożliwiać jednym kliknięciem zweryfikowanie każdego
     rekordu wobec prawdziwej strony,
   - licznik "X/Y zdjęć" (ile pobranych vs ile deklarowanych) — widoczność
     kompletności danych,
   - zwijany blok z surowym JSON tej jednej oferty (do debugowania pól).

   Na górze strony dodaj podsumowanie: łączna liczba ofert, ile ma brakujący
   opis/zdjęcia/współrzędne/rok budowy — to surowiec do sekcji "how you handled
   unstructured/low-quality data" w dokumencie z uzasadnieniem.

3. **`data/raw/otodom-offers-errors.log`** — lista ID/URL-i, których nie udało
   się pobrać lub sparsować, z powodem błędu.

## Kryteria akceptacji

- Plik JSON ma ~100 rekordów (dopuszczalne kilka mniej, jeśli któreś się nie
  powiodły — zaloguj błąd zamiast failować cały przebieg).
- Każdy rekord ma niepusty `offerUrl` prowadzący do prawdziwej, wciąż
  istniejącej oferty — sprawdź ręcznie na kilku losowych.
- Podgląd HTML otwiera się lokalnie bez serwera i pokazuje zdjęcia (nie
  połamane linki).
- Skrypt jest idempotentny: ponowne uruchomienie nie ściąga od nowa tego, co
  już jest w cache.
- Żadna oferta typu inwestycja deweloperska (`estate: "INVESTMENT"`) nie
  trafia do zbioru.
- Wszystkie rekordy dotyczą Gdańska — to jedyne wybrane źródło.

## Uwaga o wyborze języka/narzędzia

Brief narzuca tylko MySQL jako bazę danych; backend sugeruje TS+Node (dozwolony
inny język, jeśli uzasadnisz wybór w dokumencie). Skrypt scrapujący możesz
napisać w tym samym stacku co backend (spójność, reużycie typów) albo w innym
języku jako jednorazowe narzędzie — jeśli tak zrobisz, wspomnij o tym krótko w
dokumencie z uzasadnieniem jako świadomą decyzję, nie przeoczenie.
