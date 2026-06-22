# Study 02 — Contrast audit (WCAG AA)

**Date:** 2026-06-22 · **Status:** final (Phase 6)

Contrast ratios for the key token pairs against WCAG 2.2 AA (4.5:1 normal text,
3:1 large/UI). The H10 palette is sampled for *look*, so a few light greys land
below AA for body text — documented here with usage guidance. We keep the H10
values canonical; the guidance steers *where* each is safe to use.

## Text on white surface (`#ffffff`)

| Token | Hex | Ratio | Verdict |
|---|---|---|---|
| `--h10-text` | `#1c2530` | ~15.5 : 1 | ✅ AAA — body, headings |
| `--h10-text-strong` | `#3a4452` | ~9.0 : 1 | ✅ AAA — control text |
| `--h10-text-2` | `#5b6573` | ~5.9 : 1 | ✅ AA — **use for body / secondary** |
| `--h10-text-3` | `#8a93a1` | ~3.2 : 1 | ⚠️ AA large/UI only — labels, metadata, placeholders (NOT body) |
| `--h10-text-disabled` | `#aeb6c2` | ~2.0 : 1 | disabled / decorative (AA-exempt) |

## Primary + status

| Pair | Ratio | Verdict |
|---|---|---|
| `--h10-primary` `#1f6fde` text on white (links) | ~4.8 : 1 | ✅ AA |
| white on `--h10-primary` (buttons) | ~4.8 : 1 | ✅ AA |
| pill **ok** `#0a4ba8` on `#d2e6fc` | ~7.0 : 1 | ✅ AA |
| pill **warn** `#9a6700` on `#fdf3d3` | ~5.2 : 1 | ✅ AA |
| pill **arch** `#6b7480` on `#eef1f5` | ~4.0 : 1 | ⚠️ AA large only |
| success-strong `#15803d` on `#dcfce7` | ~4.9 : 1 | ✅ AA |
| danger-strong `#c0392b` on `#fde8e8` | ~5.1 : 1 | ✅ AA |

## Findings & guidance

1. **`--h10-text-3` (~3.2:1) is the main gap.** It's fine for ≥18px / bold-≥14px
   text, icons, and non-essential metadata, but **not for body copy** — use
   `--h10-text-2` (5.9:1) there. The catalog labels use text-3 at 11px uppercase
   (decorative) which is acceptable as UI, not prose.
2. **Primary blue passes AA** for both link text and white-on-blue buttons (~4.8:1).
3. **Archived pill is borderline** (~4.0:1) — fine for the small bold pill (UI),
   keep as-is.
4. **Decision:** keep H10 values; enforce the *usage* rule (body = text/text-2;
   text-3 = secondary/large only). The Phase 7 contrast lint can encode this
   (flag text-3 on body-size text).

> Ratios computed via the WCAG relative-luminance formula; treat as ±0.1.
