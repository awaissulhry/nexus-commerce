/**
 * GDS — the grid ACTION REGISTRY: one definition of a verb, rendered identically everywhere.
 *
 * A grid surface grows verbs in four places — the row context menu, a `⋯` column, the selection
 * bar, and (in the studio) the record drawer — and the failure mode is not that any one of them is
 * wrong. It is that they DRIFT: the menu offers Delete on a row the selection bar would refuse, or
 * the drawer's confirm says something the menu's does not. So a verb is declared ONCE and every
 * surface renders that declaration (the Linear model; hub ruling #110, ownership ruled in #113 —
 * the type and its adapters live here, the definitions live in each lane).
 *
 * This is deliberately the same split as `renderers/readiness.ts`: the design system owns the
 * VOCABULARY, the lane owns the DATA. A registry that also knew what "delete a variation" means
 * would be a second place for product decisions to live.
 *
 * Everything here is pure — no React, no AG — so the rules that decide whether a verb is offered,
 * and how loudly it asks, are tested rather than trusted.
 */
/**
 * What a verb acts on.
 *
 * 🔴 THREE, not two. Channel operations are naturally row-or-selection, and a registry shaped only
 * for those cannot express the third: "Add variation" and "Demote parent" act on the whole context
 * the grid is showing, not on any row in it. A `context` verb is offered by the surface that owns
 * the grid (a family bar, a toolbar), never by a row menu.
 *
 * 🔴 And a context verb must NAME ITS AXIS (PES.3's amendment, ruling #114). "Context" is not one
 * thing: on the master sheet it is the PRODUCT FAMILY, on a channel sheet the rows are alias ×
 * variant and it is the ALIAS GROUP. A bare `context` would let a family verb appear on a surface
 * whose context is an alias — the same class of mistake as a row menu offering a family verb, one
 * level up.
 */
export type ContextAxis = 'product-family' | 'alias-group';
export type ActionScope = {
    kind: 'row';
} | {
    kind: 'selection';
} | {
    kind: 'context';
    axis: ContextAxis;
};
export declare const ROW: ActionScope;
export declare const SELECTION: ActionScope;
export declare const contextOf: (axis: ContextAxis) => ActionScope;
/** Same scope AND, for a context verb, the same axis. */
export declare function sameScope(a: ActionScope, b: ActionScope): boolean;
/**
 * Whether a verb is offered here, and if not, WHY.
 *
 * 🔴 Not a boolean. "Promote to parent" is meaningless on a child, "Demote" on a standalone,
 * "Unlink" on a product with no parent — and a control that is greyed out with no explanation is
 * the trap `reference_disabled_control_cannot_explain` names: the operator cannot tell a missing
 * permission from a wrong selection from a bug. `hidden` is for a verb that does not apply at all;
 * `disabled` is for one that applies but cannot run right now, and it must say what would fix it.
 */
export type ActionAvailability = {
    kind: 'available';
} | {
    kind: 'hidden';
} | {
    kind: 'disabled';
    reason: string;
};
export declare const AVAILABLE: ActionAvailability;
export declare const HIDDEN: ActionAvailability;
export declare const disabled: (reason: string) => ActionAvailability;
/** How hard a verb makes the operator work before it runs. Chosen by the PREFLIGHT, never fixed. */
export type ConfirmLevel = 'none' | 'confirm' | 'type-to-confirm';
export type Reach = 'local' | 'local-destructive' | 'channel';
export type Fidelity = 'exact' | 'lossy' | 'none';
export interface ActionReversal {
    verb: string;
    fidelity: Fidelity;
}
export interface ActionSubject {
    kind: 'sku' | 'external-id' | 'coordinate';
    value: string;
}
export interface ActionRefusal {
    reason: string;
    whatWouldFix?: string;
    verb?: {
        label: string;
        actionId: string;
    };
}
export interface ActionHandoff {
    label: string;
    reason: string;
    href?: string;
}
/** A review describes the captured plan. Editing belongs before preflight, never in the confirm. */
export interface ActionReview {
    readonly title: string;
    readonly rows: ReadonlyArray<{
        readonly label: string;
        readonly before: string;
        readonly after: string;
    }>;
}
export interface ActionFinding {
    rowId?: string;
    label: string;
    severity: 'info' | 'warn' | 'error' | 'unknown';
    blocking?: boolean;
    /** Null means the check has never completed, not that it returned no rows. */
    asOf?: string | null;
}
/**
 * What a verb found out before asking.
 *
 * Preflight describes current facts and can refuse an unavailable action. For example, a local
 * child deletion refuses marketplace records, while demoting a parent with children requires
 * typed confirmation. The server must revalidate the reviewed membership before writing.
 */
export interface ActionImpact {
    level: ConfirmLevel;
    /** Effective reach returned by preflight; a gated channel action may only narrow its reach. */
    reach?: Reach;
    reversal?: ActionReversal;
    subject?: ActionSubject;
    acknowledge?: string;
    asOf?: string | null;
    refusal?: ActionRefusal;
    handoffs?: readonly ActionHandoff[];
    review?: ActionReview;
    /** A parameter picker was cancelled; stop silently before confirmation or execution. */
    cancelled?: boolean;
    /** The question. One sentence, in the operator's terms, naming what is about to happen. */
    title: string;
    /**
     * What will be lost or changed, itemised. Rendered as a list, never summarised into a count —
     * "5 listings" tells an operator less than naming the five marketplaces.
     */
    consequences?: string[];
    /**
     * Additional effects to review, such as clearing the variation theme when demoting a parent.
     * Moving the last child preserves the old Parent role; forced demotion detaches reviewed children.
     */
    sideEffects?: string[];
    /**
     * Per-row verdicts, when the preflight produced them.
     *
     * Structured rather than flattened into `consequences` so an EXISTING preflight-shaped call can
     * adapt into this instead of being duplicated — MS.5's publish-preview already answers
     * blocked/unlisted/warned/ready per row, and it should feed a verb's confirmation directly
     * (PES.3's amendment, ruling #114). A surface can group by severity or jump to the row.
     */
    findings?: ActionFinding[];
    /**
     * 🔴 What the preflight FETCHED, carried through to `run` so the verb applies the snapshot the
     * operator actually approved.
     *
     * Without it there is no channel between preflight and run, so a verb that had to fetch in order
     * to describe itself must fetch AGAIN to act — which costs a second marketplace round trip (the
     * call the old ChannelListingTab had to wrap in rate-limit retry) and, worse, opens a
     * time-of-check/time-of-use gap: the operator approves snapshot A and run applies snapshot B. A
     * confirmation that describes data other than what lands is the exact dishonesty `validateImpact`
     * exists to prevent, one step later in the flow. (PES.3's amendment, ruling #118.)
     *
     * The registry never reads this. Only the lane that produced it knows what it means.
     */
    payload?: unknown;
    /** For `type-to-confirm`: exactly what must be typed. A SKU, never "DELETE". */
    confirmPhrase?: string;
    /** Set when the preflight itself failed. The verb must NOT run on a guess. */
    unavailable?: string;
}
/**
 * What the host must re-read after a verb ran.
 *
 * 🔴 The LANE declares the granularity, the registry does not assume it (PES.3's amendment, ruling
 * #114). A verb that changed rows would ideally say "re-read these ids" — but a row-level refetch
 * is a CAPABILITY, and PES.3's channel sheet deliberately does not have one. A registry that
 * returned `rowIds` and assumed every host could act on it would silently no-op there: the rows
 * would change on the server and the surface would keep showing the old ones.
 *
 * So a verb says what it knows, and a host without row-refetch treats `rows` as `page`.
 */
export type ActionInvalidation = {
    kind: 'none';
} | {
    kind: 'rows';
    rowIds: string[];
} | {
    kind: 'page';
};
export interface ActionResult {
    ok: boolean;
    /** Shown verbatim on failure — the server's words, never a rewrite. */
    message?: string;
    /**
     * What changed. A cell write repaints one cell; attaching a child adds a row nothing on screen
     * knows about yet, and demoting a parent can remove several.
     */
    invalidates?: ActionInvalidation;
}
/**
 * One verb.
 *
 * `T` is the row type. Definitions live in the lane that owns the operation; this file never knows
 * what any of them mean.
 */
/**
 * The verb's wording for a given set of rows (#363).
 *
 * One resolver, because a label rendered four ways is the thing the registry exists to prevent. It
 * takes the rows rather than a count so a verb can word itself from what is actually ticked — a
 * mixed selection is a different sentence from a uniform one, and only the verb knows which.
 */
export declare function actionLabel<T>(action: Pick<GridAction<T>, 'label'>, rows: readonly T[]): string;
export interface GridAction<T> {
    id: string;
    /**
     * The verb's wording. A FUNCTION when the wording depends on what is ticked (#363).
     *
     * PES.3 collapsed Pause/Activate into one `offer-toggle`, and a fixed string cannot say
     * "Pause 3 offers" / "Activate 2 offers" — `available()` returns an availability, not a name, so
     * before this there was no way for a verb to word itself from the sheet's own state. The registry
     * already guaranteed that every surface runs the SAME verb; this extends that guarantee to what
     * every surface CALLS it.
     *
     * The string form is unchanged and every existing verb keeps it. Resolve with `actionLabel()` —
     * never read `.label` directly, or a callable one renders as "(rows) => ...".
     */
    label: string | ((rows: T[]) => string);
    scope: ActionScope;
    /** Declared before preflight. Optional only for pre-Presence callers; absence asserts no reach. */
    reach?: Reach;
    /** Destructive verbs carry danger tone. Declaration order remains pinned across surfaces. */
    danger?: boolean;
    /** Offered here? Receives the rows in scope — empty for a `context` verb. */
    available: (rows: T[]) => ActionAvailability;
    /**
     * Ask the server what this would do, before asking the operator. Omit for a verb that needs no
     * confirmation. A verb WITH a preflight never runs until it resolves — that is the whole point.
     */
    preflight?: (rows: T[]) => Promise<ActionImpact>;
    /**
     * Do it. Receives the impact its own preflight produced, so a verb acts on the snapshot the
     * operator approved rather than re-fetching a possibly different one. `impact` is absent only for
     * a verb that declared no preflight.
     */
    run: (rows: T[], impact?: ActionImpact) => Promise<ActionResult>;
}
/**
 * The order a PARAMETERISED verb runs in — documented here so each lane does not invent its own.
 *
 * **COLLECT → PREFLIGHT → CONFIRM → RUN.**
 *
 * "Add variation" and "Attach existing products" need input before anything can be described: which
 * axis values, which products. The lane owns that picker and runs it FIRST, then folds the choice
 * into its preflight — so the confirmation describes the operation the operator actually configured
 * ("attach these 3 products as Nero/L, Nero/M, Nero/S") rather than a generic one. Collecting after
 * the confirm would mean confirming a question that had not been asked yet.
 *
 * Deliberately NOT part of the type: only one lane needs it today, and a `collect` hook in the
 * registry would be a shape every verb had to think about to ignore. It gets promoted the moment a
 * second lane needs it (ruling #118).
 */
export declare const PARAMETERISED_VERB_ORDER: readonly ["collect", "preflight", "confirm", "run"];
/**
 * The verbs a surface should offer, in declaration order.
 *
 * Hidden ones are dropped; disabled ones are KEPT, because a disabled verb with a reason teaches
 * the operator something and a missing one teaches them nothing. Scope is filtered here rather than
 * by each adapter, so a row menu physically cannot offer a family verb.
 */
export declare function actionsFor<T>(actions: readonly GridAction<T>[], scope: ActionScope, rows: T[]): Array<{
    action: GridAction<T>;
    availability: ActionAvailability;
}>;
/**
 * Is this verb runnable right now? The one place a surface asks, so no adapter invents its own rule.
 */
export declare const isRunnable: (a: ActionAvailability) => boolean;
/**
 * Does this impact require the operator to type something?
 *
 * A separate function because the answer must be derivable from the impact ALONE — a surface that
 * decided severity for itself could ask less than the preflight found, which is the failure this
 * whole shape exists to prevent.
 */
export declare function requiresTypedConfirm(impact: ActionImpact): boolean;
/** Minimum level from the consequence table. Missing legacy facts never imply reversibility. */
export declare function frictionFor(impact: ActionImpact): ConfirmLevel;
export declare function requiresAcknowledgement(impact: ActionImpact): boolean;
/** One sentence from typed fidelity; callers supply the verb, never the promise. */
export declare function reversalSentence(impact: Pick<ActionImpact, 'reversal'>): string;
/** Validate the declaration before preflight, and its returned facts afterwards. Never calls it. */
export declare function validateAction<T>(action: Pick<GridAction<T>, 'reach' | 'preflight'>, impact?: ActionImpact): string[];
/**
 * Guard: an impact asking to be typed but naming no phrase is a BUG, not a lenient confirm.
 *
 * Returns the problems. A surface that finds any must refuse to run the verb rather than falling
 * back to a plain confirm — silently downgrading a typed confirm to a click is exactly how a
 * five-listing delete becomes a one-click delete.
 */
export declare function validateImpact(impact: ActionImpact): string[];
