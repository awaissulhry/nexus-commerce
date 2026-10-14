# Xavia fit finder

A "Find your size" button under the size option on the product page, made to stop wrong-size orders. It has the
same steps as the Sizebay finder on alpinestars.com (about you, body shape, result) around a 3D mannequin that takes
the shopper's own shape. It also does more:

| | Sizebay (Alpinestars) | Xavia fit finder |
| --- | --- | --- |
| Mannequin | 3D render, skin tones, fit rings | real-time 3D body (WebGL) that reshapes as the shopper types, turns by drag / touch / arrow keys, 7 body colours, glowing rings at the tape lines with labels; flat drawing when a device has no WebGL |
| Inputs | height, weight, age, shape sliders | the same, plus "how do you ride" (fit wish, what you wear under: hoodie, airbag vest) |
| Tape measure | no | optional: any measured part replaces the guess |
| Honesty | one size, no doubt shown | "65% sure, between L and XL" and a 1-minute tape step when unsure |
| Proportions | — | says when no size fits both chest and waist, or when the body is outside the chart, and links to contact |
| Wrong size in cart | — | the size option warns "S is likely too tight for you", Add to cart asks once ("Switch to L" / "Add S anyway") |
| Order | — | hidden line property `_Fit check` (e.g. `suggested L 82% (tape) \| chosen M \| chest too tight`) for the size check before shipping |
| Privacy | body data sent to Sizebay's servers | body data stays in the shopper's browser (localStorage); the order gets only the sizes |
| Result | best size, neighbour sizes, add to cart | the same (size switcher under the body, Add to cart), plus a % match gauge and each part's fit in cm |
| Speed | third-party scripts on every product page | one 41 kB (gzip) asset on the first click (or when this device has a saved profile), then one 116 kB body for the chosen body type |
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

So the result asks for a tape measure whenever it is less than 85% sure.

Finding about the charts: the women's chart allows 16 cm between chest and waist. Many real bodies have less. In the
survey, more than 1 woman in 4 has no size where both chest and waist fit (men: about 1 in 27). The finder says so plainly
("No size fits both your chest and your waist well") instead of guessing.

## The 3D mannequin

- **Body**: MakeHuman 1.1 base mesh and shape targets, CC0 1.0 (free for any use; see `body/README.md`). One body per
  body type, built offline: arms lowered, a smooth egg head instead of a face, chest smoothed, baked ambient
  occlusion, simplified to 9,446 triangles, packed by `body/pack-body.mjs` into `body/xavia-fit-body-<sex>.js`.
- **Shape** (`xavia-fit-body.js`): build from BMI (slimmer or heavier everywhere), then the bust, waist and hips
  shapes close the gap to the shopper's measures. The body measures itself with the same tape as the rings and
  corrects twice, so the 3D chest, waist, hips and height match the numbers to 0.5 cm (tested).
- **Screen** (`xavia-fit-viewer.js`): plain WebGL 1, no library, drawn only when something changes. Rings sit at the
  fullest part of the chest, the narrowest waist and the widest hips; green just right, amber close or roomy, red too
  tight or too loose; dashed orange on "How to measure". The labels follow the body as it turns.

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
| `patch-variant-picker.mjs` | edits `snippets/variant-picker.liquid` | adds 5 lines under the size option's label row |

Texts: English, Italian, German, French and Spanish (`xavia-fit-i18n.js`); other store languages show English.

## Install on the store (each step needs the Owner's yes)

1. Duplicate the live theme (`themeDuplicate`); never edit the live theme directly.
2. On the copy, upload the 5 files above and the patched `variant-picker.liquid` (`themeFilesUpsert`).
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
- The guess comes from a military survey (ages 17–58); outside its height/weight/BMI range the result asks for a tape.
- The 3D body is a guide to proportions, not a scan of the shopper; its sizes come from the same numbers as the result.
