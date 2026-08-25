import type { Tone } from '@/design-system/primitives/tone'

/**
 * The ads console's legacy `.h10-pill` vocabulary → the DS `Tone` union.
 *
 * Every mapping was chosen by MEASURED colour, not by name, and none of them lowers contrast:
 *
 *   ok    → success   #0a4ba8 on #d2e6fc   6.37 → 6.37   byte-identical
 *   warn  → warning   #9a6700 on #fdf3d3   4.39 → 4.39   byte-identical
 *   arch  → neutral   #6b7480 on #eef1f5   4.18 → 4.18   byte-identical
 *   muted → neutral   (same rule as arch)  4.18 → 4.18   byte-identical
 *   bad   → danger    5.96 → 6.27          RISES
 *
 * `success` being BLUE is not a mistake — the console's "ok = blue Enabled" convention is what
 * the DS success pill already encodes. And `bad` only became safe to map once
 * `--nds-pill-danger-fg` stopped pointing at `--nds-danger-strong`, which `.dark` overrode to a
 * light red over a light background (1.9:1).
 *
 * `bad` was also defined TWICE with different values — #a3342b in ads.css, #a3211a in
 * rules-automation.css — so the same pill changed colour depending on the page. One tone now.
 */
export function pillTone(cls: string | null | undefined): Tone {
  switch ((cls ?? '').trim()) {
    case 'ok':
      return 'success'
    case 'warn':
      return 'warning'
    case 'bad':
      return 'danger'
    case 'arch':
    case 'muted':
      return 'neutral'
    default:
      return 'neutral'
  }
}
