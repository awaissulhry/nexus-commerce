/**
 * RPX — a value against a benchmark, on a scale where both directions are the same size.
 *
 * Built for Amazon's Brand Metrics, which sends a category median and a top-performer figure
 * beside almost every measure, but it knows nothing about that feed: it takes a preformatted
 * value, a preformatted benchmark, an offset in −1..1 and a verdict. Anything comparing a
 * figure to a reference can use it.
 *
 * ── Three decisions worth keeping ──────────────────────────────────────────────
 *
 * 1. **The offset is the caller's, and it should be a RATIO, not a difference.** 798 against a
 *    median of 151.5 and 1 against a median of 9 are both large gaps; a subtraction ranks the
 *    first as 646 times the more important. Callers pass `log(ours ÷ median)` scaled into
 *    −1..1, which makes "five times ahead" and "a fifth behind" the same length of bar.
 *
 * 2. **One hue, both directions.** Ahead is not automatically good — five times the category
 *    median's detail-page views is only good news if it converts. Direction is carried by which
 *    side of the median the bar sits on and by the words at the end of the row, never by paint.
 *    The verdict text uses the status tokens; the bar does not.
 *
 * 3. **`cannot-discriminate` is a first-class state.** When a benchmark returns the same figure
 *    for us, the median AND the top performers, it cannot separate anyone — a real case on this
 *    account in all four markets. Rendering that as "level" reads as a result. The row says the
 *    benchmark is mute instead, and draws no bar.
 */
import type { ReactNode } from 'react';
export type BenchmarkVerdict = 'ahead' | 'behind' | 'level' | 'no-median' | 'no-value' | 'cannot-discriminate';
export interface BenchmarkBarProps {
    label: ReactNode;
    /** Our figure, already formatted in its own unit. */
    value: ReactNode;
    /** The benchmark it is read against, already formatted. */
    median: ReactNode;
    /**
     * Where the bar ends, −1 (far behind) to 1 (far ahead), 0 at the benchmark. Null draws no
     * bar — used for every state where a distance has no meaning.
     */
    offset: number | null;
    verdict: BenchmarkVerdict;
    /** The short read at the end of the row, e.g. "5.3× ahead". */
    distanceLabel: ReactNode;
    /** Replaces the track when there is no bar to draw, e.g. why a benchmark is mute. */
    note?: ReactNode;
    /** Scale ticks as offsets in −1..1, drawn on the track. */
    ticks?: number[];
}
export declare function BenchmarkBar({ label, value, median, offset, verdict, distanceLabel, note, ticks, }: BenchmarkBarProps): import("react/jsx-runtime").JSX.Element;
