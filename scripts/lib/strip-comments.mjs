/**
 * strip-comments — blank JS/TS comments while preserving offsets, so a scanner counts CODE.
 *
 * EXTRACTED 2026-09-02 (hub #684, DS.1-b) from `check-global-exposure.mjs`, where it was defined
 * and exported. It could not actually be imported from there: that module runs its full 2,906-file
 * scan at import time and calls `process.exit()`, so `import { stripComments }` never returns — the
 * host process dies before its next line. The ruling asked two other gates to use "the helper that
 * exists in check-global-exposure"; this is that helper, in the only place all three can reach it.
 * ONE implementation, not three copies — a copied scanner drifts, and a drifted scanner is the miss
 * nothing else can see.
 *
 * WHY OFFSETS ARE PRESERVED. Every comment character becomes a space and every newline stays a
 * newline, so line and column numbers survive the strip. A gate that reports `file:line` must not
 * report a line number from a different document than the one the author will open.
 *
 * WHY STRINGS ARE DELIBERATELY KEPT (inherited, and still right). `window['__x'] = 1` is a real
 * global exposure whose key is a string literal; blanking strings would trade a rare false positive
 * for a routine false negative. Callers that must ignore string literals blank them themselves —
 * `check-raw-primitives-ratchet` does exactly that, on one line only, and its header explains why a
 * general tokenizer breaks on JSX.
 *
 * The original rationale, kept because it is the reason this exists at all: a comment reading
 * `position: fixed` inside the change that removed it should not count as the thing it describes.
 * `check-global-exposure`'s door required assignment SYNTAX, so its prose never matched and its live
 * run was already correct — but `// window.__x = probe` in a scanned file would have counted, and
 * that is the same bug one keystroke away.
 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const two = src.slice(i, i + 2)
    if (quote) {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (two === '/*') {
      while (i < src.length && src.slice(i, i + 2) !== '*/') { out += src[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '; i += 2; continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    out += c; i++
  }
  return out
}
