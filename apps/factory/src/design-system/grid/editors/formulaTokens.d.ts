/**
 * GDS — a FORGIVING tokeniser for the formula editor's display layer (#730).
 *
 * 🔴 This is not a parser and it is never the authority on whether a formula is valid. The server's
 * `expr.ts` decides that, and its preview endpoint says so; this exists to answer "what is this run
 * of characters" while the operator is still typing, so the editor can colour it, outline the cells
 * a formula reads, and know which call the caret sits in. A client that decided validity here would
 * be the banked `reference_preview_must_run_the_engine` trap wearing a syntax highlighter.
 *
 * It differs from the server's lexer in exactly one way, deliberately: **it never throws.** Half a
 * string, a lone `$`, an unclosed `{{` are all normal mid-typing states, and an editor that stopped
 * colouring at the first of them would go blank exactly when the operator most needs to see what
 * they are writing. Those tokens come back marked `unterminated` instead.
 *
 * Token BOUNDARIES follow `expr.ts:59` exactly — `$a.b`, `${…}`, `$[…]`, `{{…}}`, two-char
 * operators before one-char, identifiers separate from refs — because the colour of a run and the
 * server's opinion of it must not disagree. Where the server would throw, this yields a token and
 * lets the preview line carry the error.
 */
export type TokenKind = 
/** `$brand`, `$a.b`, `${a b}`, `{{ a }}` — the things that read a cell. */
'ref'
/** A quoted literal. */
 | 'str' | 'num'
/** A bare word: a function name, or a keyword. */
 | 'ident' | 'op'
/** `(`, `)`, `,` */
 | 'punc' | 'ws'
/** A character the language has no rule for. Coloured as an error; the server names it. */
 | 'error';
export interface Token {
    kind: TokenKind;
    /** Offset of the first character, into the expression AS TYPED (the `=` already stripped). */
    start: number;
    /** Offset one past the last character. */
    end: number;
    /** The exact source slice. Concatenating every token's text reproduces the input. */
    text: string;
    /** For a `ref`, the attribute name without its sigil and braces. For a `str`, the raw inner text. */
    value?: string;
    /** A string or brace-reference the operator has not closed yet. Normal while typing. */
    unterminated?: boolean;
}
/**
 * Tokenise for display. Never throws; every character of `src` belongs to exactly one token, so a
 * renderer can rebuild the input from the tokens alone and cannot silently drop what it cannot
 * colour.
 */
export declare function tokenizeForDisplay(src: string): Token[];
/** Every `ref` token, in source order — what the editor outlines and colours. */
export declare const refsOf: (tokens: readonly Token[]) => Token[];
export interface BracketMatch {
    /** Offsets of the pair the caret is touching, when there is one. */
    pair?: [number, number];
    /** Offsets of every bracket with no partner — coloured as an error, never silently. */
    unmatched: number[];
}
/**
 * Bracket matching for the caret, and the unmatched ones wherever they are.
 *
 * 🔴 Unmatched brackets are reported even when the caret is elsewhere. An editor that only
 * highlights the pair under the cursor leaves a missing `)` invisible until the operator happens to
 * stand next to it, and the server's message ("unexpected end") points at the end of the line rather
 * than at the bracket that opened.
 */
export declare function matchBrackets(tokens: readonly Token[], caret: number): BracketMatch;
export interface CallContext {
    /** The function name as typed. */
    name: string;
    /** Offset of the name token — the hint anchors here. */
    nameStart: number;
    /** Which argument the caret is in, 0-based. */
    argIndex: number;
}
/**
 * Which function call the caret is inside, for the signature hint.
 *
 * Innermost wins: in `if(upper($a), …)` with the caret in `upper`'s parentheses, the hint is
 * `upper`'s. Commas are counted only at THIS call's depth, so `if(a, upper(b, c), d)` reports
 * argument 1 for `if`, never 2 — the inner call's comma belongs to the inner call.
 */
export declare function callAt(tokens: readonly Token[], caret: number): CallContext | null;
