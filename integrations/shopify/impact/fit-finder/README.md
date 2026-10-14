# Xavia fit finder

A "Size guide" link in the size option's label row of the product page (where the theme's "Size chart" link is),
made to stop wrong-size orders. It opens the size table; "Find your size" then leads through the steps around a 3D
mannequin that takes the shopper's own shape: about you (body type, height, weight, age), body shape, result. On a
phone the body type is its own step. The layout, sizes and places match the Sizebay widget on alpinestars.com
(measured from it at 1512 × 793 and 390 × 844), with the Xavia logo and our own code, texts, body and font.

| | Sizebay (Alpinestars) | Xavia fit finder |
| --- | --- | --- |
| Mannequin | 3D body, skin tones, fit rings | real-time 3D body (WebGL) that reshapes as the shopper types and moves the sliders, turns by drag / touch / arrow keys, 7 body colours, rings with fit words; faceless store-mannequin head; flat drawing when a device has no WebGL |
| Inputs | height, weight, age, shape sliders | the same |
| Result | best size, neighbour sizes, add to cart | the same, plus each neighbour size marked (fits / not recommended), "Body measurements" panel for the size, plain notes when the body is beyond the chart or the best size is sold out |
| Wrong size in cart | — | the size option warns "S is likely too tight for you", Add to cart asks once ("Switch to L" / "Add S anyway") |
| Order | — | hidden line property `_Fit check` (e.g. `suggested L 82% (height and weight) \| chosen M \| chest too tight`) for the size check before shipping |
| Privacy | body data sent to Sizebay's servers | body data stays in the shopper's browser (localStorage, several profiles); the order gets only the sizes |
| Speed | third-party scripts on every product page | one 42 kB (gzip) asset and a 48 kB font on the first click (or when this device has a saved profile), then one 175 kB body for the chosen body type |
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

The dialog asks for height, weight and age only (as the reference does); the engine also takes tape measures, fit
wishes and under-layers, and the order note keeps its confidence.

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
- **Screen** (`xavia-fit-viewer.js`): plain WebGL 1, no library, drawn only when something changes; the camera frames
  per screen match the reference. Rings sit at the fullest part of the chest and the narrowest waist; green when the
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

Measures the finder can guess and explain: `chest`, `waist`, `hips`, `inseam` (crotch to floor), `hand`
(circumference at the knuckles), `handLength`, `height`. `primary` (default: the first measure) is the part that may
not be too loose. Pants, suits and gloves need their real charts first; until then they show no button.

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
