# Docplanner – Smart Real Estate Listings (MVP)

## Źródła prawdy

- Wymagania: `docs/BRIEF.md`. Nie opieraj się na streszczeniach z logów ani wcześniejszych sesji.
- Ten plik: zasady pracy, decyzje, stan danych, reguły jakości, lista etapów.
- Szczegóły etapu dostajesz w wiadomości na początku etapu.

## Zasady pracy

1. Jeden etap na raz. Nie zaczynaj kolejnego bez mojej wyraźnej zgody.
2. Nie twórz niczego z przyszłych etapów „na zapas” (tabel, endpointów, komponentów).
3. Nie commituj. Commituję ja po weryfikacji.
4. Nowa zależność: wymień ją w raporcie i uzasadnij w jednym zdaniu.
5. Nie scrapuj ponownie Otodomu. Korzystaj z `data/raw/` i `.cache/otodom/`.
6. Jeśli brief, ten plik i prompt etapu są niejasne lub sprzeczne, zapytaj zamiast zgadywać.
7. Decyzje, które chcesz podjąć sam, NAJPIERW USTAL i wypisz wyraźnie w raporcie.

### Raport na koniec etapu

- zmienione i nowe pliki,
- komendy do uruchomienia,
- checklista kryteriów akceptacji, przy każdym komenda weryfikacji (SQL, curl, npm) i wynik,
- decyzje podjęte samodzielnie i otwarte pytania,
- znane ograniczenia (materiał do dokumentu).

Po raporcie zatrzymaj się i czekaj.

## Decyzje

- **Aplikacja:** Next.js full-stack (App Router, TypeScript). UI i route handlers w jednej aplikacji.
- **Baza:** MySQL 8 (utf8mb4) w `docker-compose`. Dostęp przez Drizzle ORM + mysql2, migracje w repo.
- **Skrypty** (import, normalizacja, AI, eval) w `scripts/`, uruchamiane przez `npm run`.
- **Dwie warstwy danych:** `offers_raw` (rekord bez zmian) → `offers` (znormalizowane). Normalizację da się przeliczyć bez scrapowania i bez sieci.
- **Wyszukiwanie:** jedna funkcja `searchOffers(filters)` używana przez stronę listy, `/api/offers` i chatbox.
- **AI :**
  - offline wzbogacanie ofert przy imporcie (podsumowanie, cechy, uwagi cenowe, brakujące piętro/rok z opisu); wyniki zapisane do pliku w repo, więc import nie wymaga klucza;
  - chatbox tekst → filtry, główne użycie AI w produkcie.
- **Podział odpowiedzialności w chacie:** LLM wyciąga intencję, kod stosuje reguły biznesowe na danych (np. co znaczy „tanie”). LLM nie wymyśla liczb.
- **Język:** kod, identyfikatory, UI, README i dokumenty oddawane po angielsku. Chat przyjmuje zapytania po polsku i angielsku.

## Stan danych po scrapowaniu

- Scraper: `scripts/scrape-otodom.ts`. Dane: `data/raw/otodom-offers.json`. Cache: `.cache/otodom/`.
- 100 ofert: mieszkania na sprzedaż, Gdańsk. Rynek pierwotny/wtórny 57/43, prywatni/agencje 7/93.
- Metraż 21,5–142,73 m² (mediana 42,4). Cena 270 000–4 489 000 zł (mediana ok. 662 000). W przedziale 40–80 m² jest 46 ofert.
- Braki: ulica 40, rok budowy 16, piętro 4. Cena, metraż, dzielnica, opis, zdjęcia i współrzędne są zawsze.
- 27 ofert ma opis identyczny z inną ofertą (szablony deweloperów).
- Pary do sprawdzenia pod kątem duplikatów: 68416389/68416387 (identyczna cena, metraż, współrzędne) oraz 68419442/68416668 (716 780 vs 716 809 zł, 65,52 vs 65,55 m²).
- 68416919: tytuł „3 pokoje”, pole rooms = TWO.
- 68419629: pole street = „420”, z opisu wynika „Kartuska 420”.
- Współrzędne wskazują budynek lub inwestycję, nie konkretne mieszkanie.
- Niektóre opisy zmieniają znaczenie ceny (np. obowiązkowe miejsce parkingowe +60 000 zł, cena brutto z 23% VAT).
- Telefony i dane osób kontaktowych to dane osobowe. Nie mogą trafić do repo ani do bazy.

## Reguły jakości danych

- Brak wartości → `NULL`, nigdy 0 ani pusty tekst. W UI: „no data”.
- Metraż z pola strukturalnego (powierzchnia użytkowa bez balkonów i tarasów). Większa liczba w tytule nie jest błędem.
- Pole strukturalne wygrywa z tytułem. Konflikt → flaga w `quality_flags`.
- Wartość spoza sensownego zakresu → `NULL` + flaga.
- Ulicy nie wyciągamy z opisu (agencje celowo jej nie podają). Nieprawidłowa ulica → `NULL` + flaga, chyba że surowe dane mają poprawną nazwę.
- Rok budowy i piętro z opisu tylko przy jednoznacznym zapisie, z oznaczeniem źródła i cytatem. Nie mylić z rokiem remontu.
- Ceny nie przeliczamy. Obowiązkowe dodatkowe koszty i uwagi o VAT → uwagi cenowe z kwotą i cytatem, widoczne na stronie oferty.
- Duplikatów nie usuwamy, tylko grupujemy (`duplicate_group_id` + oferta kanoniczna). Różne piętra oznaczają różne mieszkania.
- Szablonowe opisy wykrywamy przez hash treści i oznaczamy flagą.
- Każda wartość wywnioskowana (z opisu lub przez AI) ma zapisane źródło w `field_sources`.

## Etapy

0. Setup
1. Porządki w danych
2. Surowy import (`offers_raw`)
3. Normalizacja bez AI (`offers`)
4. Wzbogacenie AI (offline)
5. Wyszukiwanie i API
6. UI: lista i strona oferty
7. Chatbox: tekst → filtry
8. README i materiały do dokumentów

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
