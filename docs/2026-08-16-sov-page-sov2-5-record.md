# SOV.2–SOV.5 — the retroactive record

*Written by SOV.6 on 2026-08-16 because `9fc9f76a7` shipped four sections and produced no document.
SOV.0 and SOV.1 each produced one; the section map, the corrections and the known gaps in those are
what made every subsequent brief possible, including this session's.*

**Not paperwork.** SOV.6 had to build export and saved views on top of four sections nobody had
audited since they landed, and the CSV has to serialise columns this session did not write.
Everything below was read in the code and then **checked on the live page**, not taken from the
commit message.

---

## 1 · What shipped, in one commit

`9fc9f76a7` · 2026-08-15 · 5 files, +660/−22 · authored by a Fable 5 session.

| section | owns | param | default |
|---|---|---|---|
| **SOV.2** | the ad side: `Ad spend · Nd` and `Ad CPC · Nd` columns | `?adWindow=7\|14\|30` | **30** |
| **SOV.3** | `Signal` column + chips: outbid · weak-relevance · cannibalized | `?signal=` | none (all rows) |
| **SOV.4** | the unbid view | `?view=unbid` | none (all rows) |
| **SOV.5** | the row drawer | `?row=<query>@<market>` | closed |

Files: `share-of-voice.service.ts` (+282), `ShareOfVoiceClient.tsx` (+160), `SovRowDrawer.tsx`
(new, 166), `advertising-intel.routes.ts` (+27), `rules-automation.css` (+47).

---

## 2 · Section by section, with `file:line`

### SOV.2 — the ad side, on its own grain

- `ShareOfVoiceClient.tsx:295-296` — `?adWindow=` parsed, tolerating a `7d`-style suffix, validated
  against `[7, 14, 30]`, **defaulting to 30**.
- `:583` `Ad spend · {N}d` (unit `€`) and `:592` `Ad CPC · {N}d` — **both column labels carry the
  window in their header**, which is the two-grain rule made visible: the share columns say "as of a
  week", these say "over N days", and no single control moves both.
- Sourced from `AmazonAdsSearchTerm` scoped to the resolved campaigns. `AmazonAdsSearchTerm.campaignId`
  is Amazon's **external** id, resolved before the scope test — the trap `3f91c9a60` records.
- Blank rows carry the ad side too, so *"we buy this query and Brand Analytics never shows us"* is a
  visible state rather than an empty row.

### SOV.3 — the signals, re-cut against medians

- `share-of-voice.service.ts:217-235` — `SovSignal` / `SOV_SIGNALS`, three definitions:
  - `outbid` — above-median CPC **and** below-median ad impressions
  - `weak-relevance` — ≥50 ad impressions **and** CTR under half the median
  - `cannibalized` — ≥2 of our own campaigns buying the same query
- `:472` — the bars are **all medians**. The legacy service compared impressions to the **mean**,
  which SOV.0's study measured as firing on 32% of the account (1,925 of 1,992 queries sit below the
  mean). This is the fix that study asked for.
- `:378` — `?signal=` validated against the same list.
- Chip counts are computed **before** the narrowing, so every chip delivers the number it promises
  rather than the number that survives its own filter.

### SOV.4 — the unbid view

- `ShareOfVoiceClient.tsx:299` — `?view=unbid`, the only accepted value.
- Selects: measured presence in the chosen period, **no** ad activity in the ad window, and **no**
  enabled keyword target.
- The boundary with Keyword Harvest is stated on the page: harvest promotes terms we already **paid**
  on; this is demand we have never touched.

### SOV.5 — the row drawer

- `ShareOfVoiceClient.tsx:300` — `?row=<query>@<market>`; `SovRowDrawer.tsx` (166 lines).
- Carries: every measured week for the query, **with the pre-`ACR.0.2` parser weeks flagged and never
  plotted as a collapse** (SOV.1 §2.4's finding, honoured); cart-add and purchase share as drawer
  facts (2.9% / 0.2% coverage — the reason SOV.1 refused them as columns); which ASIN holds the term;
  observed vs declared buyers.
- The first column became a real link and the P0 un-link CSS rules were **deleted**, exactly as their
  comments promised they would be when the cell became a control.

---

## 3 · Verified on the live page

*(Checked in a browser on prod, 2026-08-16, not read off the diff.)*

| what | state |
|---|---|
| eleven columns render | Query · Market · Market volume · Market rank · Market impression share · Δ vs prior week · Click share · ASINs competing · Ad spend · Ad CPC · Signal · As of |
| the two grains are labelled | the ad columns carry `· 30d` in their headers; the share columns carry the week |
| `?adWindow=` | moves only the two ad columns' labels and values |
| `?signal=` · `?view=unbid` · `?row=` | all round-trip |
| the first column | a real link that opens the drawer; no `cursor: pointer` on a non-link cell remains |

---

## 4 · Gaps and defects found while looking

1. 🔴 **`?adWindow=` defaults to 30 and is not written back.** Unlike `market` (which SOV.0 writes
   into the URL when it defaults), a link with no `?adWindow=` means "30 today" rather than "30".
   If the default ever changes, every existing link silently re-points. One line, and it is the same
   argument SOV.0 made for `market`.
2. **`?signal=` and `?view=` narrow the grid but the census stays pre-narrowing** — correct, and
   deliberate, but the page does not say so beside the chip counts. A reader who filters to `outbid`
   and sees the census unchanged has to infer why.
3. **The ad columns have no confidence floor.** SOV.1 established that a share needs its denominator
   checked and gave click share its own floor (median 17 clicks vs 370 impressions). `Ad CPC` over a
   1-click query is the same class of number and is not flagged. It is a CPC rather than a share, so
   the argument is weaker — but it is the same shape and worth a decision rather than an omission.
4. **No deliverable doc, which is what this file is repairing.** The cost was real and immediate:
   SOV.6 had to re-derive the column list, the params and their defaults from source before it could
   serialise them into a CSV.

None of these were fixed here — they belong to whoever next holds those sections, and SOV.6's scope
is §4–§6 of its own brief. They are recorded so the next brief can price them.

---

## 5 · What SOV.6 consumed from these four

The export's header block and its column set are built directly on the above: `?adWindow=` and its
**own** age are written into the header **separately** from the share period, because SOV.2's
two-grain rule holds in a file exactly as it does on screen; `signal` and `view` are written into the
active-filter line; and `delta-no-prior` joins the four SOV.0 blank states as the fifth exported
token. Had this record not been written, the CSV would have been a guess at four sections' semantics.
