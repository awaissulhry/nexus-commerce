/**
 * matchesAccept — does a file satisfy an `accept` list?
 *
 * Extracted from `FileDropzone` (hub #633) for two reasons. The first is the bug: the inline version
 * compared `file.type === ext` for any entry not starting with `.`, so a MIME **wildcard** could
 * never match — `accept="image/*"` refused every file, because a PNG's `type` is `image/png` and
 * never the literal string `image/*`. The second is that it could not be tested where it lives:
 * `FileDropzone.handle()` dispatches `onFiles(picked)` in the same pass as the check, so on a real
 * surface an accepted file is an *uploaded* file, and the positive case cannot be exercised in situ
 * without a live upload (PES.7). As a pure function it is testable without one.
 *
 * Takes a structural `{ name, type }` rather than `File` so the suite runs under apps/web's
 * node-only vitest — no jsdom, no `File` polyfill.
 */
/** The parts of `File` an accept check reads. `File` satisfies this structurally. */
export interface AcceptCandidate {
    name: string;
    type: string;
}
/** `'.csv, .tsv'` -> `['.csv', '.tsv']`. Empty entries dropped; an empty list means "accept any". */
export declare function parseAccept(accept: string): string[];
/**
 * Three entry forms, matching the HTML `accept` attribute:
 *   `.png`        extension, matched against the file NAME
 *   `image/*`     MIME wildcard, matched against the TYPE's prefix
 *   `image/jpeg`  exact MIME type
 * An empty list accepts anything, as the attribute's absence does.
 *
 * A file with no `type` (the browser could not determine one) matches no MIME entry — deliberately,
 * since the alternative is accepting an unknown binary because it happened to be untyped. It can
 * still match by extension.
 */
export declare function matchesAccept(file: AcceptCandidate, exts: string[]): boolean;
