/**
 * A Negative Targeting builder rule's settings, in plain words (audit M4, 2026-10-11): the rule detail's Settings tab reads
 * what the builder stored — its criteria, its Ad Group Mapping, its search-term and brand filters, where its negatives
 * go, when it runs and its limits — instead of the engine view the Bid page's reader gives a rule that is not a bid
 * rule. The "Stop waste — may run alone" test is shown beside it by the tab. Pure, tested in Node.
 */
import { currencySymbol, dayWords, money } from '../../bid/_shared/format'
import type { SettingGroup, SettingsContext, StoredRule } from '../../bid/rules/ruleSettings'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {})
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : [])
const str = (v: unknown) => (v == null ? '' : String(v).trim())

/** The builder's operators, short. */
const OP: Readonly<Record<string, string>> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }
/** The builder's metrics in money and in percent (PerformanceCriteria `PC_METRIC_UNIT`). */
const MONEY = new Set(['Sales', 'Spend', 'CPC'])
const PCT = new Set(['ACOS', 'CTR', 'CVR'])
const METRIC_WORD: Readonly<Record<string, string>> = { ACOS: 'ACoS', 'PPC Orders': 'PPC orders' }

/** One condition: "Sales = €0", "Clicks ≥ 5", "ACoS > 40 %". */
export function conditionWords(c: Obj, currency = 'EUR'): string {
  const metric = str(c.metric)
  const v = str(c.value).replace(',', '.')
  const value = !v ? '…' : MONEY.has(metric) ? `${currencySymbol(currency)}${v}` : PCT.has(metric) ? `${v} %` : v
  return `${METRIC_WORD[metric] ?? (metric || '?')} ${OP[str(c.op)] ?? str(c.op)} ${value}`
}

const TYPE_WORD: Readonly<Record<string, string>> = { E: 'negative exact', P: 'negative phrase', product: 'negative product target' }
const LEVEL_WORD: Readonly<Record<string, string>> = { adgroup: 'Ad group', campaign: 'Campaign', both: 'Ad group + campaign' }
const NO_MAX = 'No max'
const euroCents = (v: number | null | undefined) => (v == null ? NO_MAX : money(v, 'EUR'))

/** The settings of a Negative Targeting builder rule; null for any other rule (the Bid page's reader reads those). */
export function negativeBuilderSettings(rule: StoredRule, ctx: SettingsContext = {}): SettingGroup[] | null {
  const a0 = obj(list(rule.actions)[0])
  if (a0.type !== 'negative-targeting') return null
  const currency = ctx.currency ?? 'EUR'
  const groups: SettingGroup[] = []
  // Audit R-M1 — "Pause keyword, keep it paused" reads the criteria and the ad groups it looks in, nothing else: no
  // target it creates, no search-term filter, no negation level. Its test and action are the tab's Stop waste part.
  const pause = obj(a0.stopWaste).kind === 'PAUSE_KEYWORD'
  const every = pause ? 'Every keyword' : 'Every search term'

  const blocks = list(rule.conditions)
  groups.push({
    id: 'criteria',
    title: 'Criteria',
    items: blocks.length
      ? blocks.map((b, i) => {
        const ifs = list(b.conditions).map((c) => conditionWords(c, currency))
        return { label: blocks.length > 1 ? `Criteria ${i + 1}` : 'If', value: ifs.length ? ifs.join(' and ') : every }
      })
      : [{ label: 'If', value: every }],
  })

  const mapped = list(a0.mappings).flatMap((m) => list(m.groups))
  if (pause) {
    const looking = mapped.filter((g) => g.look !== false)
    groups.push({
      id: 'where',
      title: 'Where it pauses',
      items: looking.length
        ? looking.map((g) => ({ label: 'Ad group', value: [str(g.campaignName), str(g.name) || str(g.id)].filter(Boolean).join(' › ') }))
        : [{ label: 'Ad groups', value: 'Every ad group in its market' }],
    })
    pushRunsAndMade(groups, rule, ctx, 'Keywords a day')
    return groups
  }
  groups.push({
    id: 'mapping',
    title: 'Ad Group Mapping',
    items: mapped.length
      ? mapped.map((g) => {
        const types = obj(g.types)
        const creates = (['E', 'P', 'product'] as const).filter((t) => types[t] === true).map((t) => TYPE_WORD[t])
        const name = str(g.name) || str(g.id)
        return {
          label: str(g.campaignName) ? `${name} · ${str(g.campaignName)}` : name,
          value: `${g.look === false ? 'Does not look for search terms' : 'Looks for search terms'} · ${creates.length ? `creates a ${creates.join(', ')}` : 'creates nothing'}`,
        }
      })
      : [{ label: 'Ad groups', value: 'None: the search term\'s own ad group gets a negative exact' }],
  })

  const terms = list(a0.searchTerms)
  const filters = obj(a0.filters)
  const brands = Array.isArray(filters.brandExclude) ? (filters.brandExclude as unknown[]).map(str).filter(Boolean) : []
  const termWords = (op: string) => terms.filter((t) => str(t.op) === op).map((t) => `"${str(t.term)}"`)
  const contains = termWords('contains')
  const without = termWords('not')
  groups.push({
    id: 'terms',
    title: 'Search terms',
    items: [
      { label: 'Contains', value: contains.length ? contains.join(', ') : 'Any' },
      ...(without.length ? [{ label: 'Does not contain', value: without.join(', ') }] : []),
      { label: 'Brand terms never negated', value: brands.length ? brands.join(', ') : 'None' },
      { label: 'Competitor ASINs only', value: filters.competitorOnly === true ? 'Yes' : 'No' },
    ],
  })

  const protect = a0.protectConverting !== false
  groups.push({
    id: 'negatives',
    title: 'Negatives',
    items: [
      { label: 'Negation level', value: LEVEL_WORD[str(a0.negationLevel) || 'adgroup'] ?? str(a0.negationLevel) },
      { label: 'Do not re-negate', value: a0.dedupe === false ? 'Off' : 'On' },
      { label: 'Never negate a term that converted', value: protect ? `On · last ${str(a0.protectDays) || '30'} days` : 'Off' },
    ],
  })

  pushRunsAndMade(groups, rule, ctx, 'Matches a day')
  return groups
}

/** When it runs, its limits ("Keywords a day" for a pause, "Matches a day" for search terms) and who made it. */
function pushRunsAndMade(groups: SettingGroup[], rule: StoredRule, ctx: SettingsContext, perDay: string): void {
  groups.push({ id: 'runs', title: 'Runs', items: [{ label: 'When', value: ctx.schedule || 'Every 15 min' }] })
  groups.push({
    id: 'caps',
    title: 'Limits',
    items: [
      { label: perDay, value: rule.maxExecutionsPerDay == null ? NO_MAX : String(rule.maxExecutionsPerDay) },
      { label: 'Changes a day', value: rule.maxWritesPerDay == null ? NO_MAX : String(rule.maxWritesPerDay) },
      { label: 'Ad spend a day', value: euroCents(rule.maxDailyAdSpendCentsEur) },
    ],
  })
  const by = str(rule.createdBy)
  const who = !by ? '' : by === 'user' || by.startsWith('user:') ? 'You' : /^claude/i.test(by) ? 'Claude' : by
  groups.push({ id: 'made', title: 'Made', items: [{ label: 'Created', value: [rule.createdAt ? dayWords(rule.createdAt) : null, who || null].filter(Boolean).join(' · ') || '—' }] })
}
