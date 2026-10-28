/**
 * Canonical control size scale. Components pick the contiguous subset they support.
 *
 * `xs` is the DENSE tier: 11.5px text, 4px/9px padding, ~23px tall. It exists for controls that
 * live inside a grid row, where `sm` (12.5px / 6px 11px, ~28px) adds height to every row.
 *
 * Derived by census 2026-08-25, not by guess: dense form controls across the ads console cluster
 * at 13px (71), 12.5px (56), 12px (43) and 11.5px (29). `md` and `sm` already covered the first
 * two. 12px is half a pixel from `sm` and rounds to it — adding a step there would repeat the
 * radius scale's mistake, where 6px and 7px are indistinguishable and both exist. Vertical
 * padding tied 15:14 between 5px and 3px, so 4px is the midpoint, and it lands the control at
 * 23px — the smallest height the console actually declares.
 */
export type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
