# AI enrichment prompt (version 1)

This is the exact instruction handed to each enrichment subagent. It lives in the repository so the
enrichment pass is reproducible and reviewable: the prompt, the input batches, the raw model output and
the validator log are all committed artifacts.

**Model:** Claude Opus, run as a Claude Code subagent during development — not a runtime API call.
The product itself never calls this model; it reads the validated result from `data/enriched/otodom-ai.json`.

**Version:** recorded as `prompt_version: 1` in the merged output. Bump it whenever the text below changes.

---

## Prompt

````
You are extracting structured facts from Polish real estate listing descriptions.

Read the input file: data/enriched/input/batch-NN.json
Write your result to:  data/enriched/output/batch-NN.json

The input holds up to 10 offers. Each has: id, title, description (Polish, plain text),
may_infer_floor, may_infer_year_built, building_floors.

## Absolute rules

1. Every value you output must be supported by a `quote`: a string copied CHARACTER FOR CHARACTER
   from that offer's `description`. Do not translate, trim, fix typos or reflow the quote.
   A quote that is not a literal substring of the description is rejected by an automatic validator.
2. Never infer, estimate or assume. If the description does not say it plainly, leave it out.
   An empty result is a correct result.
3. Work offer by offer. Never let one offer's text justify a value for another offer —
   many listings share identical developer boilerplate.

## Fields to produce per offer

- `summary`: 2-3 sentences in English describing the flat for a listings site.
  Use ONLY facts present in the title and description. Do not add adjectives the source
  does not support, do not invent selling points, do not mention prices or numbers that
  are not in the source text. Plain, factual, no marketing language.

- `features`: array of `{ "feature": <slug>, "quote": <verbatim fragment> }`.
  Allowed slugs, and nothing else:
    balcony, terrace, garden, elevator, parking, storage, air_conditioning,
    ready_to_move_in, needs_renovation, developer_standard
  Use `ready_to_move_in` only for a finished flat, `developer_standard` for unfinished
  developer condition ("stan deweloperski"), `needs_renovation` for one requiring renovation.

- `price_notes`: array of `{ "type": <type>, "amount_pln": <number, optional>, "quote": <verbatim fragment> }`.
  Types: mandatory_parking | extra_cost | vat_note | other
  These capture text that changes what the advertised price actually means, for example:
  a parking space or garage sold separately or obligatorily, a storage unit at extra cost,
  a note that the price is gross or that VAT must be added.
  Include `amount_pln` only when a concrete amount appears in your quote; write it as a plain
  number (150000, not "150 000 zł").

- `floor`: `{ "value": <integer>, "quote": <verbatim fragment> }` or null.
  ONLY when `may_infer_floor` is true AND the description states the floor unambiguously.
  Ground floor = 0. The value must not exceed `building_floors` when that is given.
  A sentence about "a lift in the building" or "10 minutes to the beach" is not a floor.

- `year_built`: `{ "value": <integer>, "quote": <verbatim fragment> }` or null.
  ONLY when `may_infer_year_built` is true AND the description states the year the building
  was CONSTRUCTED. Beware: renovation years, move-in dates, investment completion dates and
  "available from" dates are NOT the build year. If in doubt, output null.

## Output format

Write exactly this JSON shape, nothing else, no markdown fence:

{
  "batch": <the batch number from the input>,
  "prompt_version": 1,
  "results": [
    {
      "id": <offer id>,
      "summary": "...",
      "features": [{ "feature": "balcony", "quote": "..." }],
      "price_notes": [{ "type": "mandatory_parking", "amount_pln": 60000, "quote": "..." }],
      "floor": null,
      "year_built": null
    }
  ]
}

Include every offer id from the input, even when all of its fields are empty.
Do not report progress in your final message: write the file, then reply with one line —
the batch number and the number of offers processed.
````

---

## What happens next

`npm run ai:merge` validates every value against the database and the source text, drops whatever
fails, logs each rejection with its reason to `data/enriched/rejected.log`, and writes the surviving
values to `data/enriched/otodom-ai.json`. The number of rejections is reported on purpose: it is the
evidence that model output is treated as a proposal, not as truth.
