# Content & data standards

## Language
- **The operator UI is English.** Italian (and other EU locales) is for
  **customer-facing listing content only** — never the console chrome. DS
  components ship English defaults; user-facing copy is passed in by the consumer
  (slots), so components stay locale-agnostic.
- The few built-in strings (e.g. "Select all", "No matches", "Discard",
  "Cancel") are English UI labels by design. Make one overridable via a prop only
  when a real need appears — don't pre-globalize the chrome.

## Data formatting
Use `@/design-system/lib/format` — never hand-roll `Intl`:
- `eur(cents)` / `eur0(cents)` / `eurMicros(micros)` — money is **cents-based**
  (Amazon convention), `en-IE` currency.
- `num(n)` grouped integer · `pct(fraction)` (input `0.149` → `"14.9%"`) ·
  `x2(n)` multiplier · `formatDate(iso)` → `en-GB` "22 Jun 2026".
- Locales are **fixed** in the formatters so SSR and client match (no hydration
  drift from the host locale).
- Align numeric columns with `font-variant-numeric: tabular-nums` (DataGrid +
  MetricStrip already do).

## Iconography
`lucide-react` is the standard (see `../primitives/icons/`). Use **15–16px** in
dense UI, let color inherit (`currentColor`). Custom SVGs live in
`primitives/icons/`.

## Voice
Sentence case for labels and buttons ("New campaign", not "New Campaign").
Concise, action-first. Numbers before nouns ("3 selected").
