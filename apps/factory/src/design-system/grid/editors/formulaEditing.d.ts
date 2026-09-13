/**
 * GDS — the cell editor's FORMULA rules, as pure functions (D16 / wave-4 §1.6).
 *
 * The editor component is React and cannot be rendered in this repo's node-only vitest, so
 * everything that can be decided without a DOM is decided here: when the editor is in formula mode,
 * which `$reference` the caret is in, what the autocomplete should offer, and what the text becomes
 * when one is chosen. The component is then wiring.
 *
 * 🔴 The leading `=` is a UI CONVENTION, not part of the language. `=` is a real equality operator
 * inside `expr.ts` (`:187`), so a formula sent with its `=` still attached parses as a comparison
 * against nothing. §1.6(B) makes stripping it the CLIENT's job and the server refuses a stored
 * `expr` that begins with `=`. `exprOf()` is the only place that strip happens.
 */
/** A completion the editor can offer: a field the row has, or a function the language has. */
export interface FormulaCandidate {
    /** What gets inserted after the `$` (a field key) or before `(` (a function name). */
    name: string;
    kind: 'field' | 'function';
    /** The human label — a column's header, or a function signature. */
    label?: string;
    group?: string;
    /**
     * The row's CURRENT value for this field, as text.
     *
     * 🔴 The autocomplete shows it, and it is the half that answers the operator's actual question.
     * A list of keys makes them guess which column holds what they mean — `$item_name` and
     * `$product_description` are indistinguishable by name on a row where one is filled and the other
     * is empty. Absent for functions, and absent rather than `''` for a field with no value, so the
     * caller can tell "nothing here" from "not applicable".
     */
    value?: string;
}
/** Formula mode is the leading `=`, and nothing else. */
export declare const isFormulaDraft: (text: string) => boolean;
/**
 * The expression as the SERVER must receive it: the leading `=` gone, nothing else touched.
 *
 * Only the FIRST `=` is a mode switch; `="a" = "b"` keeps its real equality operator.
 */
export declare function exprOf(text: string): string;
/**
 * Is the caret inside a string literal?
 *
 * 🔴 `$brand` inside quotes is TEXT, not a reference — `="$brand"` publishes the five characters.
 * Offering autocomplete there would insert a completion that silently does nothing, which is the
 * worst kind of help: it looks like it worked. Scanned from the start of the expression because a
 * quote's meaning depends on everything before it, and escapes are honoured so `="a\"b$c"` is still
 * inside its string.
 */
export declare function inStringLiteral(text: string, caret: number): boolean;
export interface RefToken {
    /** The characters typed after the `$`, possibly empty when the `$` was just pressed. */
    query: string;
    /** Index of the `$` itself. */
    start: number;
    /** Index one past the last character of the token. */
    end: number;
}
/**
 * The `$reference` the caret sits in, or `null`.
 *
 * A reference is `$` followed by letters, digits and underscores — the shape `expr.ts` accepts.
 * The caret must be inside or immediately after the token: with `$brand` typed and the caret moved
 * back to the line's start, the operator is no longer editing that reference and an open menu would
 * be about a token they have left.
 */
export declare function refTokenAt(text: string, caret: number): RefToken | null;
/**
 * Candidates for a query, best-first: exact prefix matches before contained matches, each group
 * alphabetical. Case-insensitive — an operator typing `$BR` means `brand`.
 *
 * Fields come before functions: the Owner's cases are "pull the value from that column", and a
 * language reference is the rarer need.
 */
export declare function completionsFor(query: string, candidates: readonly FormulaCandidate[], limit?: number): FormulaCandidate[];
export interface Applied {
    text: string;
    caret: number;
}
/**
 * Insert a completion over the token the caret is in.
 *
 * A FUNCTION brings its `(` and leaves the caret between the parentheses — the next thing typed is
 * always an argument. A FIELD does not: `$brand` is complete on its own.
 */
export declare function applyCompletion(text: string, token: RefToken, c: FormulaCandidate): Applied;
/**
 * A reference the row's own column set does not contain.
 *
 * 🔴 This is a TYPING AID, not a verdict, and the difference matters. The server is the authority on
 * what resolves — its preview reports `unresolved` — and a client that decided "unknown" from its
 * own column list would be re-implementing the resolver in the browser, the banked
 * `reference_preview_must_run_the_engine` trap. This only reports references the sheet in front of
 * the operator has no column for, which is enough to catch a typo at the moment it is made and is
 * never the reason a formula is refused.
 */
export declare function unknownRefs(expr: string, knownKeys: readonly string[]): string[];
/**
 * What the editor hands back to the grid when the edit STOPS.
 *
 * 🔴 This exists because AG owns the keys, and the first design fought it and lost three times.
 * Enter, Tab and Escape are all handled by AG's own listeners, which sit below React's root
 * container and therefore run first — measured on the live sheet: a React `onKeyDown` with
 * `stopPropagation` never got Enter, and a native capture listener on the editor's container did
 * not either. So the editor does NOT intercept Enter; AG stops the edit and reads this.
 *
 * That made the seeding of the committed value the whole ballgame. Seeding it with the ORIGINAL
 * value (to keep a stray blur from committing half-typed text) meant a formula could never be saved
 * at all — every commit returned the value the operator started with, silently. Seeding it with the
 * live text fixes that and reopens the stray-commit question, which is what this rule answers:
 *
 *   a bare `=` — the mode switch, nothing typed after it — is NOT a formula and commits nothing.
 *
 * That is the one state a stray blur actually produces (open a cell with `=`, click away), and the
 * route would refuse it anyway with a 400 that the sheet would surface as a failed write. A
 * half-written formula still commits and is still refused by the server, with its reason — which is
 * the honest outcome, and better than this file guessing at what "finished" means.
 */
export declare function commitValue(text: string, original: string, kind?: CommitKind): string | number;
/** What the column stores, so a plain edit through the formula editor round-trips as itself. */
export type CommitKind = 'text' | 'number';
/**
 * 🔴 A NUMBER column must not be handed a string (#775).
 *
 * The formula editor is a text field, so everything the operator types arrives as one. On a `text`
 * column that is the value. On a `number` column it is not: storing `"105"` where `105` belongs
 * gives the cell a value of the wrong TYPE, which sorts as text, compares as text and reaches the
 * writer as text — and nothing on the way would have complained.
 *
 * This only bites because `=` opens this editor on numeric cells now: the operator can type `=`,
 * delete it, and finish with a plain number in a field that was never the numeric editor.
 *
 * 🔴 An unparseable entry is returned AS TYPED rather than swallowed. Returning the original would
 * silently discard what they wrote; returning `null` would delete the cell. The string goes to the
 * server, which refuses it, and the sheet shows the refusal with its reason — visible and
 * correctable, which a silent discard is not. Blank is the exception: an empty field means "clear
 * this", and `''` is how every other column says so.
 */
export declare function coerceTyped(text: string, kind: CommitKind): string | number;
export type FormulaAvailability = {
    kind: 'available';
} | {
    kind: 'blocked';
    reason: string;
};
/**
 * One wording for "this column cannot hold a formula", so the editor, the tooltip and any future
 * surface cannot describe the same refusal three ways.
 *
 * It says what is true and what to do instead. It does NOT say "not writable" — the column usually
 * is writable, by hand; it is the FORMULA writer that has a shorter list.
 */
export declare const FORMULA_BLOCKED_REASON = "This field cannot hold a formula. Type a value instead.";
/** The server exposes the ordinary writer's field gate. Existing formulas remain inspectable. */
export declare function formulaAvailability(input: {
    formulaWritable?: boolean;
    hasStoredFormula?: boolean;
}): FormulaAvailability;
/** Which editor a cell should open. Pure, so the policy can be tested without a grid. */
export type FormulaEditorChoice = {
    use: 'formula';
} | {
    use: 'fallback';
};
/**
 * The four rules that decide whether `=` gets the formula editor (#775, hoisted at PES.3's request).
 *
 * 🔴 This is POLICY, not wiring, which is why it is here and not copied into each sheet. Master and
 * the channel scopes must reach the same verdict about the same cell, and a second copy would mean
 * the first person to fix one of these fixes it on one scope — the drift the Owner's
 * "shared = exactly the same" rule exists to stop. It is the identical argument that moved
 * `useCellFormulas` out of `sheet/master/`, and it applies one layer down.
 *
 * It is separated from the SELECTOR that consumes it because the selector must name a React
 * component, and a module importing a `.tsx` cannot be imported by this repo's node-only vitest at
 * all — it would report "no tests" and look green while never running. Splitting them is what makes
 * these four rules testable.
 */
export declare function formulaEditorChoice(input: {
    /** The keystroke that began the edit. `=` is the mode switch and the only one. */
    eventKey?: string | null;
    /** The formula already stored on this cell, if any. */
    storedExpr?: string | null;
    /** PES.5's per-column gate. Absent is UNKNOWN, not "no" — see `formulaAvailability`. */
    formulaWritable?: boolean;
    /** A formula stored for another row must never be offered on this one. */
    rowWritable?: boolean;
}): FormulaEditorChoice;
/**
 * Which completion Tab accepts — the HIGHLIGHTED one.
 *
 * 🔴 Extracted so it can be tested at all. It is three lines and it lived inline in the editor,
 * where this repo's vitest cannot reach it: `apps/web` runs node-only with no jsdom and no JSX
 * transform, so a rule inside a `.tsx` reports "no tests" and looks green while never running.
 *
 * 🔴 `shown` is the panel's own list, NOT the options handed to it. `ListboxPanel` re-ranks with
 * `searchOptions` and reorders with `groupOptions`, so index `i` of what is DRAWN and index `i` of
 * what was PASSED IN are different rows. Indexing the input array inserts a completion the operator
 * did not highlight — and on a short list the two orders usually agree, so the defect is invisible
 * until the list is long enough that someone actually needs the keyboard.
 *
 * The fallbacks are ordered and each earns its place: `shown[active]` is the answer; `shown[0]`
 * covers the first Tab after the list opens, because the panel reports its list one effect later
 * and `shown` is momentarily empty; `passed[0]` covers the case where it never reports at all.
 * Returns `null` rather than a guess when there is nothing to accept.
 */
export declare function completionToAccept<T>(shown: readonly T[], passed: readonly T[], active: number): T | null;
/** What `PUT /pim/formulas/product/:id` said, as the route actually shapes it. */
export interface FormulaSaveResponse {
    ok?: boolean;
    error?: string | null;
    lastError?: string | null;
    formula?: {
        lastError?: string | null;
    } | null;
}
export type FormulaSaveOutcome = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export declare const FORMULA_STORED_NOT_EVALUATED = "The formula was stored but could not be evaluated.";
/**
 * Did the save succeed — from the BODY, never from the status.
 *
 * 🔴 **A refusal arrives as HTTP 200 with `ok: false`.** Witnessed live (UX.1, 2026-09-03, master·DE,
 * `batteries_included`): `200 {"ok":false, lastError:'"maybe" is not an allowed value for Are
 * batteries included? — choose one of: true, false'}` — the value layer untouched, the formula KEPT
 * so the operator can correct it in place. A check that reads the status alone records that refusal
 * as a success, and the cell would stamp "saved" over a value that was never written.
 *
 * `ok === false` explicitly, not `!ok`: a response that omits the field is not a refusal, and
 * treating a missing flag as failure would report every older payload as refused.
 *
 * The reason falls through three shapes because the route has carried all three — top-level `error`,
 * top-level `lastError`, and `formula.lastError`. It never invents one: if the body refuses without
 * saying why, the operator gets a sentence that says exactly that rather than a blank warning.
 */
export declare function formulaSaveOutcome(body: FormulaSaveResponse | null | undefined): FormulaSaveOutcome;
/** Suggestions at `=`, after an operator, in a $reference, or while typing a function. */
export declare function completionTokenAt(text: string, caret: number): RefToken | null;
/** A clicked field replaces the selected text or reference; quoted text stays literal. */
export declare function insertFieldReference(text: string, start: number, end: number, name: string): Applied | null;
