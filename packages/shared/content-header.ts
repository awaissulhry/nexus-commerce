/**
 * ONE header grammar for a transfer/export column (LX.F P2-13 + LX.7V's F3).
 *
 * `key` on a shared scope · `key@<language>` on a shared scope with a language ·
 * `key@<channel>:<MARKET>:<language>` on a coordinate · and a non-scalar cell
 * declares its FORM before the coordinate (`key[]`, `key[measure]`).
 *
 * There were two writers and they disagreed in three ways the parser could not
 * repair, all measured by LX.7V:
 *   master + `de` → API `title@de`, web `title` — which parse to DIFFERENT TIERS
 *     (`{tier:'language',language:'de'}` vs `{tier:'source'}`), so a round-trip
 *     wrote German text onto the Italian source;
 *   channel casing → API `title@amazon:IT:de`, web `title@AMAZON:IT:de`;
 *   channel without a language → API `brand@amazon:IT:`, web `brand@AMAZON:IT`.
 *
 * The grammar is a WIRE CONTRACT, so it belongs beside the parser's own rules
 * rather than in either app. The API's spelling is the one kept: it is the live
 * producer (`catalog-workbook.ts` → `languageHeader`), so no existing file changes
 * meaning. `import-diff.service.ts` `parseHeader` is the reader, and its
 * round-trip is asserted arm by arm.
 */
export type ContentHeaderForm = 'list' | 'measure' | null | undefined

export interface ContentHeaderScope {
  /** `'channel'` emits the coordinate; anything else (or absent) is the shared scope. */
  kind?: string | null
  channel?: string | null
  marketplace?: string | null
  locale?: string | null
}

/** Language-only, lowercase — the same rule as `normalizeLanguage`, without the throw. */
const language = (locale: string) => locale.toLowerCase().split(/[-_]/, 1)[0]

export function contentHeaderKey(field: string, scope: ContentHeaderScope, form?: ContentHeaderForm): string {
  const declared = form === 'list' ? `${field}[]` : form === 'measure' ? `${field}[measure]` : field
  const channelScope = !!scope.channel && !!scope.marketplace && scope.kind !== 'master'
  if (!channelScope) return scope.locale ? `${declared}@${language(scope.locale)}` : declared
  return `${declared}@${scope.channel!.toLowerCase()}:${scope.marketplace!.toUpperCase()}:${scope.locale ? language(scope.locale) : ''}`
}
