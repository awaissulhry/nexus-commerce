/**
 * LX.13 — the compare pane's targets, built ONCE for both sheet hosts.
 *
 * Design §8 LX.13: "`compareTargets` on both hosts = every language of the field (source first) +
 * every coordinate carrying it; copy-across writes through the router with the target's
 * `ContentAddress` (a copy onto a coordinate is a pin and says so)." Screen truth: the mock's S6
 * (`/design/language-axis`) — source row first, then the other shared languages, then coordinates.
 *
 * Before this module each host built its own list inline: master offered ONE target (itself), and
 * the channel host offered master plus itself. With one target the pane can only say "no other
 * scopes are wired" — which is what it said. Two inline builders for one rule is the
 * two-column-builders shape (`reference_two_column_builders_drift`), so the rule lives here and
 * both hosts spread it.
 *
 * Pure and label-injected: `channelLabel` / `languageLabel` are passed in from `_studio/scopes.ts`
 * so this module holds no channel or language map of its own (`reference_a_list_of_members_is_a_set_claim`).
 */

import type { CompareTarget, DrawerScope, SheetChannel } from '../drawer/types'

/** One coordinate the family is listed on, in the language that coordinate is read in. */
export interface CompareCoordinate {
  channel: SheetChannel
  marketplace: string
  accountId?: string
  aliasId?: string
  locale: string
}

export interface BuildCompareTargetsInput {
  /** The scope the drawer is open on. Its `locale` decides which row is marked "this record". */
  scope: DrawerScope
  /**
   * The content languages of the SHARED record, in the wire's order. Derived from
   * `Marketplace.languages` upstream (LX.2's one authority) — never a literal here.
   */
  languages: readonly string[]
  /** The configured source language (`/marketplaces/grouped` `_meta.primaryLanguage`). */
  primaryLanguage: string | null
  /** Coordinates that carry the field. The open coordinate belongs in this list. */
  coordinates: readonly CompareCoordinate[]
  labels: { channel: (channel: SheetChannel) => string; language: (language: string) => string }
  /** The shared record's own label, for the language rows' scope. */
  masterLabel: string
  /** The market the shared record is read on — the sheet route demands one for `scope=master`. */
  masterMarket?: string
}

export const languageTargetId = (language: string) => `language:${language}`
export const coordinateTargetId = (c: CompareCoordinate) =>
  JSON.stringify(['coordinate', c.channel, c.marketplace, c.accountId ?? '', c.aliasId ?? '', c.locale])

/**
 * Source first, then the remaining languages in the order the authority gave them, then the
 * coordinates. A language that is not in `languages` but IS the open scope's own language is still
 * offered: a market can be read in a language the shared record has no row for yet, and hiding it
 * would hide the very cell the operator opened the pane on.
 */
export function buildCompareTargets(input: BuildCompareTargetsInput): CompareTarget[] {
  const { scope, primaryLanguage, labels } = input
  const ordered = [...new Set([
    ...(primaryLanguage ? [primaryLanguage] : []),
    ...input.languages,
    ...(scope.locale ? [scope.locale] : []),
  ].map(language => language.toLowerCase()).filter(Boolean))]

  const languageTargets: CompareTarget[] = ordered.map(language => ({
    id: languageTargetId(language),
    // `· source` / `· shared` is the tier, not decoration: it says which row a copy would change.
    label: `${labels.language(language)} · ${language === primaryLanguage ? 'source' : 'shared'}`,
    kind: 'locale',
    scope: {
      kind: 'master',
      label: `${input.masterLabel} · ${labels.language(language)}`,
      ...(input.masterMarket ? { marketplace: input.masterMarket } : {}),
      locale: language,
    },
  }))

  const seen = new Set<string>()
  const coordinateTargets: CompareTarget[] = []
  for (const c of input.coordinates) {
    const id = coordinateTargetId(c)
    if (seen.has(id)) continue
    seen.add(id)
    coordinateTargets.push({
      id,
      label: `${labels.channel(c.channel)} · ${c.marketplace} · ${c.locale}`,
      kind: 'channel',
      scope: {
        kind: 'channel',
        channel: c.channel,
        marketplace: c.marketplace,
        ...(c.accountId ? { accountId: c.accountId } : {}),
        ...(c.aliasId ? { aliasId: c.aliasId } : {}),
        locale: c.locale,
        label: `${labels.channel(c.channel)} · ${c.marketplace} · ${c.locale}`,
      },
    })
  }

  return [...languageTargets, ...coordinateTargets]
}

/**
 * Which target IS the record on screen — matched by COORDINATE **including the language** (#342.2,
 * one dimension further).
 *
 * The drawer's own matcher compared kind, channel, marketplace, alias and account. That was exact
 * while a scope had one language; with a language target per language of the shared record, a
 * master scope read in German matched the ITALIAN row, so the column an operator copies FROM would
 * have been the wrong language's text. No `?? targets[0]` fallback: marking an arbitrary target as
 * "this record" is the same failure one step quieter.
 */
export function matchesOpenRecord(target: CompareTarget, scope: DrawerScope): boolean {
  return target.scope.kind === scope.kind
    && (target.scope.channel ?? null) === (scope.channel ?? null)
    && (target.scope.marketplace ?? null) === (scope.marketplace ?? null)
    && (target.scope.aliasId ?? '') === (scope.aliasId ?? '')
    && (target.scope.accountId ?? null) === (scope.accountId ?? null)
    && (target.scope.locale ?? null) === (scope.locale ?? null)
}
