import { COMPANY_ID, STYLE_ID } from '../../../demo/fixtures'
import { failed, ready } from '../model'
import type { MarketChoice, StyleMarketsView } from './api'
import type { MarketsModel } from './model'

/**
 * Made-up markets for the design cases of the Overview's "Markets" (B-W2b-283, FU1:01; SCR-342 cases `w2b-283-*`): the demo
 * jacket DEMO-JKT-01 of the styles' demo and invented market profiles (codes, names and languages of the demo only). No
 * `designScreen` here: SCR-342's fixtures file spreads these cases into its own list.
 */

const OTHER_COMPANY = '0190f0e2-8888-7000-8000-000000000283'

const market = (code: string, name: string, it: string, languages: string[], extra: Partial<MarketChoice> = {}): MarketChoice => ({
  code,
  name,
  nameI18n: { it, en: name },
  companyId: null,
  status: 'ACTIVE',
  switchedOn: true,
  docLanguages: languages,
  userInfoLanguages: languages,
  labelLanguages: languages,
  picked: false,
  offered: true,
  ...extra,
})

const MARKETS: MarketChoice[] = [
  market('IT', 'Italy', 'Italia', ['it']),
  market('DE', 'Germany', 'Germania', ['de']),
  market('FR', 'France', 'Francia', ['fr']),
  market('CH', 'Switzerland', 'Svizzera', ['de', 'fr', 'it'], { switchedOn: false }),
  market('UK', 'United Kingdom', 'Regno Unito', ['en']),
]

/** The demo jacket's markets: `codes` named ([] = every market); `archived` names an archived market too, `other` another company's. */
export function demoMarkets(options: { codes?: string[]; archived?: boolean; other?: boolean; mayChange?: boolean; refusal?: StyleMarketsView['refusal'] } = {}): StyleMarketsView {
  const codes = [...(options.codes ?? []), ...(options.archived ? ['ES'] : []), ...(options.other ? ['AT'] : [])]
  const extra: MarketChoice[] = [
    ...(options.archived ? [market('ES', 'Spain', 'Spagna', ['es'], { status: 'ARCHIVED', offered: false })] : []),
    ...(options.other ? [market('AT', 'Austria', 'Austria', ['de'], { companyId: OTHER_COMPANY, offered: false })] : []),
  ]
  return {
    style: { id: STYLE_ID, code: 'DEMO-JKT-01', name: 'Giacca Touring Demo', companyId: COMPANY_ID, version: 9, status: 'ACTIVE' },
    marketCodes: codes,
    standing: codes.length === 0 ? 'EVERY_MARKET' : 'SOLD_THERE',
    markets: [...MARKETS, ...extra].map((entry) => ({ ...entry, picked: codes.includes(entry.code) })),
    mayChange: options.mayChange ?? true,
    refusal: options.refusal ?? null,
  }
}

export function marketsModel(over: Partial<MarketsModel> = {}): MarketsModel {
  return { styleCode: 'DEMO-JKT-01', part: ready(demoMarkets({ codes: ['IT', 'DE'] })), online: true, busy: false, pick: null, problem: null, notice: null, ...over }
}

/** SCR-342's `w2b-283-*` cases: the label, the model and what the case shows. */
export const MARKET_CASES: readonly { id: string; label: string; markets: MarketsModel; note?: string }[] = [
  { id: 'w2b-283-markets-every', label: 'W2b-283 Markets: none picked (every market)', markets: marketsModel({ part: ready(demoMarkets()) }), note: 'Sold everywhere as before: the language rules of every market wait at the gates until a market is picked.' },
  { id: 'w2b-283-markets-list', label: 'W2b-283 Markets: sold in Italy, Germany and Switzerland (switched off)', markets: marketsModel({ part: ready(demoMarkets({ codes: ['IT', 'DE', 'CH'] })) }), note: 'Each market in words with its code; a switched-off one marked, never colour alone.' },
  { id: 'w2b-283-markets-kept', label: 'W2b-283 Markets: an archived and another company’s market still named', markets: marketsModel({ part: ready(demoMarkets({ codes: ['IT'], archived: true, other: true })) }), note: 'Named before; they stay until taken off (the database checks a code only when it is added).' },
  {
    id: 'w2b-283-markets-pick',
    label: 'W2b-283 Markets: the pick (pop-up)',
    markets: marketsModel({ part: ready(demoMarkets({ codes: ['IT', 'DE'], archived: true })), pick: { codes: ['IT', 'DE', 'FR', 'ES'] } }),
    note: 'The company’s markets and every company’s, each with the languages the gates ask there; an archived one named before can only be taken off; Save held until something changes; ⌘↵.',
  },
  { id: 'w2b-283-markets-pick-every', label: 'W2b-283 Markets: the pick, nothing ticked', markets: marketsModel({ pick: { codes: [] } }), note: 'Nothing ticked: sold in every market (said before Save).' },
  { id: 'w2b-283-markets-pick-same', label: 'W2b-283 Markets: the pick, nothing changed', markets: marketsModel({ pick: { codes: ['DE', 'IT'] } }), note: 'Save held: "Nothing changed yet."' },
  { id: 'w2b-283-markets-refused', label: 'W2b-283 Markets: refused meanwhile', markets: marketsModel({ pick: { codes: ['IT', 'DE', 'FR'] }, problem: 'markets.problem.market' }), note: 'A market was archived between the read and Save: said above the buttons, the markets read again.' },
  { id: 'w2b-283-markets-saved', label: 'W2b-283 Markets: saved', markets: marketsModel({ notice: { key: 'markets.notice.saved', tone: 'success', params: { count: 2 } } }) },
  {
    id: 'w2b-283-markets-blocked',
    label: 'W2b-283 Markets: held by the edit rule',
    markets: marketsModel({ part: ready(demoMarkets({ codes: ['IT'], refusal: { code: 'EDIT_BLOCKED', message: 'Blocked.' } })) }),
    note: 'Discontinued with a blocked edit rule: Change… held with why.',
  },
  { id: 'w2b-283-markets-reader', label: 'W2b-283 Markets: a reader', markets: marketsModel({ part: ready(demoMarkets({ codes: ['IT', 'DE'], mayChange: false })) }), note: 'Read only: Change… held, "You can view, not change."' },
  { id: 'w2b-283-markets-offline', label: 'W2b-283 Markets: offline', markets: marketsModel({ online: false }), note: 'Change… held: it waits for the connection.' },
  { id: 'w2b-283-markets-loading', label: 'W2b-283 Markets: loading', markets: marketsModel({ part: { status: 'loading' } }) },
  { id: 'w2b-283-markets-error', label: 'W2b-283 Markets: the read failed', markets: marketsModel({ part: failed('markets.problem.readFailed') }), note: 'Said in words with Try again; the rest of the Overview stays usable.' },
]
