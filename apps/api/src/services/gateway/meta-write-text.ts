/**
 * Text a person types (review A8, round 2): any script, never a control or format character (U+202E turns text around,
 * U+200C, tag characters U+E0020–E007F, a soft hyphen hide or reorder it). STRICT for the EU payer and beneficiary (shown
 * to people as the advertiser's identity). A NAME also takes U+200D (zero-width joiner) only BETWEEN two emoji, as a
 * family or job emoji is written; anywhere else it is refused. One pattern each, used by the tools' zod and this gateway.
 *
 * Step 39: a leaf module (it imports nothing). The rule files meta-calls.ts loads (meta-brand-safety-rules.ts, and every
 * later rules file) use these patterns at load time, so they must not import them from meta-settings-rules.ts, which
 * imports meta-calls.ts: that import cycle threw "Cannot access 'META_NAME_TEXT' before initialization" whenever
 * meta-settings-rules.ts was loaded first.
 */
export const META_STRICT_TEXT = /^[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]*$/u
export const META_NAME_TEXT = /^(?:[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]|(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic}))*$/u
/**
 * Text of several lines (a comment, a post, a caption): META_NAME_TEXT and a line break (U+000A). Derived from it, never
 * written again. Step 37 made it (meta-comment-rules.ts re-exports it); step 24 moved it here, the leaf, so every rules file
 * takes it from the leaf.
 */
export const META_COMMENT_TEXT = new RegExp(META_NAME_TEXT.source.replace(/^\^\(\?:/, '^(?:\\n|'), 'u')
