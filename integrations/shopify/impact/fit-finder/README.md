# Xavia fit finder

A "Size guide" link in the size option's label row of the product page (where the theme's "Size chart" link is),
made to stop wrong-size orders. It opens the size table; "Find your size" then leads through the steps around a 3D
mannequin that takes the shopper's own shape: about you (body type, height, weight, age), **your measurements**, body
shape, your size. On a phone the body type is its own step. The steps follow the product's chart: the measurements
step has one field per measure of that chart (a jacket: chest and waist; with sleeve length: three; gloves: hand
circumference and length; a helmet: head), and the body shape step appears only for torso parts left to our
estimate. The flow is as short as the Sizebay widget on alpinestars.com; the layout is our
own: a wide modal (up to 1080 × 680) with a top bar (logo, language, profiles, close), the product photo or the 3D body
on the left and the step on the right, a named progress line, and the title and buttons in the same place on every
step. A copy of the earlier Sizebay-style layout is commit fbcee1b47.

| | Sizebay (Alpinestars) | Xavia fit finder |
| --- | --- | --- |
| Mannequin | 3D body, skin tones, fit rings | real-time 3D body (WebGL) that reshapes as the shopper types and moves the sliders, turns by drag / touch / arrow keys, 7 body colours, rings with fit words; faceless store-mannequin head; flat drawing when a device has no WebGL |
| Inputs | height, weight, age, shape sliders | the same, plus a field for each measure the product's chart uses, with our estimate shown (never filled in) and the tape value taking over when typed; "how to measure" follows the field being typed, with dashed rings on the 3D body; a measure we cannot estimate well (head, foot) must be typed; the 3D body already follows height and weight as they are typed; each slider says where it stands ("Chest · Average"); height also in metres ("1,80") or feet and inches, typed text never rewritten, Enter goes on |
| Language | the store's | the store's first; a switch in the dialog (English, Italiano, Deutsch, Français, Español) keeps the step and what was typed, and stays for the visit; the product page keeps its own language |
| Size table | rows and columns change with the chart | fixed columns and one row height per product: women / men, cm / in and the language never move a row or a column |
| Result | best size, neighbour sizes, add to cart | the size with its fit in words ("Chest: just right"), every size of the chart in one row to compare, the body measurements of the size on screen; the button names the size it adds ("Add L to cart"); a size that is not recommended can still be added on purpose ("Add M anyway"); "Closest size" with an amber mark when even the best size is too tight or too loose somewhere; every neighbour size marked; a sold-out best size offers the next size that fits |
| Wrong size in cart | — | the size option warns "S is likely too tight for you", Add to cart asks once ("Add L instead" / "Add S anyway"), naming every part that will not fit |
| Order | — | hidden line property `_Fit check` (e.g. `suggested L 82% (height and weight) \| chosen M \| chest too tight`) for the size check before shipping |
| Privacy | body data sent to Sizebay's servers | body data stays in the shopper's browser (localStorage, several profiles); the order gets only the sizes |
| Screens and access | desktop and phone layouts | phones, tablets, touch screens, low windows and 200% zoom get a full-screen layout with 44 px touch targets that scrolls instead of squeezing; keyboard, focus and screen-reader names checked; text contrast to WCAG AA; a loading spinner on the link and the stage |
| Profiles | on this device | the same, the profile in use named on its button, delete asks once more |
| Speed | third-party scripts on every product page | one 48 kB (gzip) asset and a 48 kB font on the first click (or when this device has a saved profile), then one 175 kB body for the chosen body type |
| Cost | paid service | none |

## How the size is worked out

`xavia-fit-engine.js` (pure functions, tested in Node):

1. **Body guess** from height, weight, age and body type: linear fits on the public ANSUR II survey
   (US Army 2012, 4,082 men and 1,986 women). Chest is usually within ±3 cm (men) / ±4 cm (women).
   Shape answers move a part by 0.8 of that spread per step. A tape value replaces the guess for that part.
2. **Each size** of the product's chart is scored: the body should sit in the middle of the size's range
   (closer to the top for "Close" fit or leather, lower for "Relaxed"); being over the top costs more than being
   under (armour that cannot close); room on a secondary part (a jacket's waist) costs little (adjusters).
   Under-layers add to the body: hoodie +3 cm chest and waist, airbag vest +5 cm chest / +4 cm waist.
3. **Confidence**: 400 bodies drawn around the guess; the share that gets the same size.
4. **Labels** per part: too tight (> 3 cm over the range), close fit, just right, roomy, too loose (> 5 cm under).

Checked against all ANSUR II people with the men's and women's jacket charts (truth = their own tape measures):

| Input | Men: exact size | Men: within 1 size | Women: exact | Women: within 1 |
| --- | --- | --- | --- | --- |
| Height + weight + age | 61% | 99% | 56% | 97% |
| + chest by tape | 80% | 100% | 71% | 99.6% |
| Chest + waist by tape | sure (only the chart decides) | | | |

The dialog asks height, weight and age, then the product's own measurements: each one is our estimate until the shopper
types a tape value (the result marks which numbers are estimates). The engine also takes fit wishes and under-layers,
and the order note keeps its confidence.

Survey fits added for other products (same model): sleeve (`sleeveoutseam`, shoulder point to wrist; R² 0.64, ±1.8
cm), neck (`neckcircumferencebase`; ±1.6 / 1.3 cm), thigh (±2.1 / 2.3 cm), calf (±1.6 / 1.7 cm). Head circumference
(R² 0.17–0.28) and foot length (R² 0.55, ±0.85 cm against a 0.67 cm boot size step) are not guessed: the shopper
measures them.

Finding about the charts: the women's chart allows 16 cm between chest and waist. Many real bodies have less. In the
survey, more than 1 woman in 4 has no size where both chest and waist fit (men: about 1 in 27). The finder says so plainly
("No size fits both your chest and your waist well") instead of guessing.

## The 3D mannequin

- **Body**: MakeHuman 1.1 base mesh and shape targets, CC0 1.0 (free for any use; see `body/README.md`). One body per
  body type, built offline: a smooth faceless head (skull, jaw and chin kept, simple ears), arms lowered (and turned out
  a little more on wider builds, so they never go into the body), chest smoothed, baked ambient occlusion, about 12,500
  triangles, packed by `body/pack-body.mjs` into `body/xavia-fit-body-<sex>.js`.
- **Shape** (`xavia-fit-body.js`): build from BMI (slimmer or heavier everywhere), then the bust, waist and hips
  shapes close the gap to the shopper's measures. The body measures itself with the same tape as the rings and
  corrects twice, so the 3D chest, waist, hips and height match the numbers to 0.5 cm (tested).
- **Screen** (`xavia-fit-viewer.js`): plain WebGL 1, no library, drawn only when something changes; one camera frame
  per screen (the whole body while height and weight are typed, the upper body for the shape, the torso for the result). Rings sit at the fullest part of the chest and the narrowest waist; green when the
  size fits, red when it does not; dashed orange on "How to measure". The labels follow the body as it turns.

## Which product gets which chart

`xavia-fit-finder.liquid` decides, in this order:

1. The product's JSON metafield **`xavia.fit_chart`**, when set. One of:
   - a default chart's key: `"men-jacket"`;
   - a whole chart (see the format below);
   - `{ "men": <key or chart>, "women": <key or chart> }`.
2. Else a product whose type or any tag is `jacket`, `jackets`, `vest`, `gilet`, `giacca` or `giubbotto` gets the
   jacket charts from `xavia-fit-charts.liquid`: tag `men` only → men's chart, tag `women` only → women's chart,
   both or neither → both charts (the shopper's body type picks one, as the store's size chart shows today).
3. Else no button: the theme's own "Size chart" link stays exactly as it is.

A `leather` tag sets the recommendation a little closer (leather gives with wear). Only sizes the product sells are
shown and recommended. Chart format (BODY measurements in cm, each size `[from, to]`):

```json
{ "cut": "men", "measures": ["chest", "waist"], "primary": ["chest"],
  "sizes": [{ "name": "M", "chest": [94, 98], "waist": [82, 86] }] }
```

Measures a chart may list (`MEASURES` in `xavia-fit-engine.js`, with the values a person can have): `chest`, `waist`,
`hips`, `sleeve` (shoulder point to wrist), `neck`, `inseam` (crotch to floor), `thigh`, `calf`, `head`, `foot`, `hand`
(circumference at the knuckles), `handLength`, `height`. Every one has a name and a "how to measure" text in the five
languages. `primary` (default: the first measure) is the part that may not be too loose. Pants, suits, gloves and
helmets need their real charts first (a metafield per product, or a default chart in `xavia-fit-charts.liquid`); until
then they show no button.

## Garment measurements (hidden)

A product may also carry the measurements of the finished garment per size, in the JSON metafield
**`xavia.fit_garment`** (Nexus sends it; the shopper never sees it). The shopper still gives only body measurements.
The dialog uses the garment only to check the room between garment and body (`ROOM` in `xavia-fit-engine.js`):

- a measure the chart also has (chest): the chart says how it fits; the garment adds "too tight" when it leaves less
  than the least room (the product runs small), and that size is then not advised;
- a measure only the garment has (sleeve): it is asked in the measurements step (estimated until measured) and gets
  its own fit word from the room band (lengths say short/long); a size outside the band costs in the ranking;
- no metafield, or nothing usable in it: the dialog works from the chart alone, exactly as before (tested).

The garment numbers are never put on the screen (the size table shows body measures only; a garment check carries
no cm). They are in the page source, as every metafield the theme renders is.

```json
{ "measures": ["chest", "waist", "sleeve"],
  "sizes": [{ "name": "M", "chest": 106, "waist": 94, "sleeve": 62.5 }],
  "room": { "chest": [6, 16] } }
```

Circumferences are the full way round (Nexus doubles a measure taken flat); `sleeve` = shoulder seam to cuff;
`inseam` = crotch seam to hem. Garment measures: `chest`, `waist`, `hips`, `neck`, `thigh`, `calf`, `sleeve`,
`inseam`. `room` is optional: [least, most] cm of garment over the body per measure; else the `ROOM` defaults.

## Files

| File | Goes to the theme as | What |
| --- | --- | --- |
| `xavia-fit-finder.liquid` | `snippets/xavia-fit-finder.liquid` | button, product data, a small boot script |
| `xavia-fit-charts.liquid` | `snippets/xavia-fit-charts.liquid` | default charts (from IT_MENS_JACKET.jpg, IT_WOMEN.jpg) |
| `dist/xavia-fit-finder.js` (git-ignored) | `assets/xavia-fit-finder.js` | built by `build.mjs` from the engine, texts, 3D body and viewer code, dialog, CSS |
| `body/xavia-fit-body-male.js`, `-female.js` | `assets/` (same names) | the packed 3D bodies, loaded on open |
| `fonts/xavia-fit-inter.woff2` | `assets/xavia-fit-inter.woff2` | Inter (SIL Open Font License 1.1, `fonts/OFL.txt`), the dialog's own font |
| `patch-variant-picker.mjs` | edits `snippets/variant-picker.liquid` | puts the "Size guide" link where the theme's size chart link is (that link stays for products without a chart) |

Texts: English, Italian, German, French and Spanish (`xavia-fit-i18n.js`); other store languages show English.

## Install on the store (each step needs the Owner's yes)

1. Duplicate the live theme (`themeDuplicate`); never edit the live theme directly.
2. On the copy, upload the 6 files above and the patched `variant-picker.liquid` (`themeFilesUpsert`).
   `patchVariantPicker()` refuses when Impact's markup moved; then place the hook by hand.
3. Open the copy's preview on a jacket, a women-only jacket, a leather jacket, pants and gloves; check the
   cart's `_Fit check` property and a phone width.
4. Publish the copy (`themePublish`). The previous theme stays for rollback.

## Checks

```sh
node integrations/shopify/impact/fit-finder/build.mjs          # before uploading assets/xavia-fit-finder.js
node --test integrations/shopify/impact/verification/fit-*.test.mjs
# Browser: a stand-in product page that renders the real snippets (liquidjs) and mimics Impact's picker and form.
npm i --no-save liquidjs   # or LIQUIDJS=/path/to/liquidjs/dist/liquid.node.mjs
node integrations/shopify/impact/verification/fit-finder/server.mjs 4317 &
node integrations/shopify/impact/verification/fit-finder/run.mjs http://127.0.0.1:4317/ /tmp/fit-shots
```

The stand-in is not proof of Shopify behaviour; the preview theme is.

## Known limits

- "Buy it now" (Shop Pay) skips the add-to-cart check; the size hint above it still shows.
- The guess comes from a military survey (ages 17–58); outside its height/weight/BMI range the result says so and
  points to the size table.
- The 3D body is a guide to proportions, not a scan of the shopper; its sizes come from the same numbers as the result.
