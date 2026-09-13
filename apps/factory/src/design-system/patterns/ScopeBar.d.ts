import { type ReactNode } from 'react';
import { type ScopeReadinessState } from '../grid/renderers/readiness';
export type { ScopeReadinessState };
/**
 * How complete a scope is, as far as the SERVER has said.
 *
 * The DS owns the render contract only — a state from the shared vocabulary and a percentage that
 * is allowed to be unknown. What the percentage counts, and which validator produced it, is the
 * caller's business.
 */
export interface ScopeBarReadiness {
    /**
     * 🔴 `null` is NOT zero and is never drawn as `0%`.
     *
     * In a completeness vocabulary `0%` states that everything required is missing, which is a
     * strong and usually false claim about a scope nobody has scored yet. Unknown renders `—`, and
     * `note` is what turns that dash into an answer.
     */
    pct: number | null;
    state: ScopeReadinessState;
    /** The source's own sentence. Shown on hover; never reworded by the bar. */
    note?: string;
}
export interface ScopeBarItem {
    id: string;
    label: string;
    /** Omit entirely when this scope carries no readiness; `'loading'` while it is being fetched. */
    readiness?: ScopeBarReadiness | 'loading';
    disabled?: boolean;
    /**
     * Why it is disabled. Required in practice, not by the type: a disabled control that cannot
     * explain itself is a dead end (reference_disabled_control_cannot_explain). It becomes the
     * chip's tooltip and its `aria-description`.
     */
    disabledReason?: string;
}
export interface ScopeBarProps {
    /**
     * Show the readiness PERCENTAGE beside the state word. Default `true`.
     *
     * 🔴 The asymmetry is the point (spec §14.4). When a chip cannot fit both, the STATE survives and
     * the number is dropped — never the reverse. `Amazon · Blocked` still tells an operator which tab
     * to open next; `Amazon 71%` does not, because 71% is one numeral standing for two different
     * verdicts: "warnings, publishable" and "blocked". A bar that drops the word to keep the number
     * has kept the decoration and thrown away the answer.
     */
    showPercent?: boolean;
    /**
     * A visible eyebrow before the chips ("SCOPE").
     *
     * When given it is ALSO the group's accessible name, via `aria-labelledby` — so the label a
     * sighted operator reads and the one a screen reader announces are the same string, and cannot
     * drift apart the way a visible label plus a separate `aria-label` eventually does.
     */
    label?: string;
    /** Accessible name when there is no visible `label`. A radiogroup with no name is unlabelled. */
    ariaLabel?: string;
    items: ScopeBarItem[];
    active: string;
    onChange: (id: string) => void;
    /** The `[+]` affordance at the end of the chips (adding a listing alias, connecting a channel). */
    onAdd?: () => void;
    addLabel?: string;
    /**
     * The right-hand controls — market, locale.
     *
     * They are a SLOT, not props, on purpose: the bar must never grow a second control for a fact a
     * chip already states. The chips name the channel; whatever goes here names the coordinate they
     * are read at. Two controls for one fact is what sank the reverted ads scope bar.
     */
    right?: ReactNode;
    className?: string;
}
/**
 * ScopeBar — choose which LAYER of a record you are editing.
 *
 * A row of chips (a master/base scope plus one per channel), each carrying how complete that scope
 * is, and a slot for the coordinate controls those chips are read at. Built for the Product Edit
 * Studio (PES.1), where the same sheet is re-projected per scope.
 *
 * ⚠ It is not a filter bar. It does not narrow a result set; it changes which stored layer the
 * surface below is showing and writing. The ads console's `*ScopeBar` files answer the other
 * question (market × portfolio × campaign reach) and were merged into `AdsFilterBar` — nothing
 * here is a fork of them, and nothing there should become a fork of this. That page-local bar was
 * re-forked at least three times precisely because it never became one DS component
 * (reference_ra_scope_bar_forked_three_times).
 *
 * Semantics: a `radiogroup`, because this is one choice out of N — not a tablist, which would put a
 * second set of tab semantics beside the surface's real tab strip. Arrow keys move the selection;
 * a roving tabindex keeps the group a single tab stop.
 */
export declare function ScopeBar({ label, ariaLabel, items, active, onChange, onAdd, addLabel, right, className, showPercent, }: ScopeBarProps): import("react/jsx-runtime").JSX.Element;
