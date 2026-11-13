import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PRODUCTION_STRATEGIES, STRATEGY_ITEM_KINDS, STRATEGY_LIMITS, STRATEGY_WORDS, type ProductionStrategy } from '@nexus/factory-domain/planning/strategy/rules'
import { officeContextOf } from '../../../modules/planning/access'
import { listSettings } from '../../../modules/planning/settings/settings'
import { listStrategy, type ListStrategyQuery } from '../../../modules/planning/strategy/strategy'
import { defineExportSource } from '../source'

/**
 * Planning › Long range › Master schedule & S&OP, its production strategy per item (SCR-202 sec:strategy, `/planning/mps`, the
 * list frame's key `planning.mps`; B-W2b-339's screen on B-W2b-319's read, B-W2b-383 follow-up XF8:06): the list as the screen
 * shows it, through the module's own listStrategy (planning.view over the site), by item code, a page at a time. The address
 * is the page's (apps/factory-web areas/planning/mps model.ts controlsOf): `?site=` (a site of the screen's company the person
 * plans, else the first by code, as the screen picks it from GET /planning/settings), `?q=`, `?kind=FINISHED|COMPONENT`,
 * `?strategy=`, `?set=set|default`. "Last changed" is the change's moment (a date and time of the file); who made it stays
 * on the screen. Pieces of planning only: no money.
 */

interface Query extends Omit<ListStrategyQuery, 'siteId' | 'cursor' | 'limit'> {
  readonly site: string | null
}

type Row = Awaited<ReturnType<typeof listStrategy>>['items'][number]

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined => ((values as readonly string[]).includes(value ?? '') ? (value as T) : undefined)
const strategyWords = (language: 'it' | 'en') => Object.fromEntries((Object.entries(STRATEGY_WORDS) as [ProductionStrategy, { en: string; it: string }][]).map(([code, words]) => [`strategy.${code}`, words[language]]))

export const mps = defineExportSource<Query, Row>({
  listKey: 'planning.mps',
  page: '/planning/mps',
  permission: PLANNING_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100)
    const set = address.get('set')
    return {
      site: address.get('site') || null,
      ...(q ? { q } : {}),
      ...(oneOf(STRATEGY_ITEM_KINDS, address.get('kind')) ? { kind: oneOf(STRATEGY_ITEM_KINDS, address.get('kind')) } : {}),
      ...(oneOf(PRODUCTION_STRATEGIES, address.get('strategy')) ? { strategy: oneOf(PRODUCTION_STRATEGIES, address.get('strategy')) } : {}),
      ...(set === 'set' || set === 'default' ? { set: set === 'set' } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const context = officeContextOf(caller)
    // The screen's sites: the ones it plans, of its company, by code; the asked one, else the first.
    const sites = (await listSettings(caller, context.companyId ? { companyId: context.companyId } : {})).sites.map((entry) => entry.site).sort((a, b) => a.code.localeCompare(b.code))
    const siteId = sites.find((site) => site.id === query.site)?.id ?? sites[0]?.id ?? null
    if (!siteId) return { rows: [], next: null }
    const { site: _site, ...filter } = query
    const page = await listStrategy(caller, { ...filter, siteId, ...(cursor ? { cursor } : {}), limit: Math.min(limit, STRATEGY_LIMITS.page.max) })
    return { rows: page.items, next: page.nextCursor }
  },
  idOf: (row) => row.item.id,
  columns: {
    item: { value: (row, words) => [row.item.code, row.item.name, row.sku ? `${row.sku.style.code} · ${row.sku.colourway.name} · ${row.sku.size}` : words(`kind.${row.item.kind}`)].join(' · ') },
    strategy: { value: (row, words) => (row.set ? words(`strategy.${row.strategy}`) : `${words(`strategy.${row.strategy}`)} · ${words('cell.default')}`) },
    colours: {
      value: (row, words) => {
        const apart = row.rows.filter((entry) => entry.colour !== null)
        return apart.length === 0 ? words('cell.allColours') : apart.map((entry) => `${entry.colour!.name}: ${words(`strategy.${entry.strategy}`)}`).join(' · ')
      },
    },
    reason: { value: (row, words) => row.lastChange?.reason ?? (row.lastChange ? words('cell.noReason') : null) },
    changed: { value: (row, words) => (row.lastChange ? { at: row.lastChange.at } : row.set ? words('cell.changedUnknown') : words('cell.neverSet')) },
  },
  words: {
    it: {
      ...strategyWords('it'),
      'kind.FINISHED': 'Capo finito',
      'kind.COMPONENT': 'Componente',
      'cell.default': 'predefinita',
      'cell.allColours': 'Tutti i colori uguali',
      'cell.noReason': 'Nessun motivo indicato',
      'cell.changedUnknown': 'Impostata prima che le modifiche fossero registrate',
      'cell.neverSet': 'Mai impostata: su ordine per impostazione predefinita',
    },
    en: {
      ...strategyWords('en'),
      'kind.FINISHED': 'Finished garment',
      'kind.COMPONENT': 'Component',
      'cell.default': 'by default',
      'cell.allColours': 'Every colour alike',
      'cell.noReason': 'No reason given',
      'cell.changedUnknown': 'Set before changes were recorded',
      'cell.neverSet': 'Never set: make to order by default',
    },
  },
})
