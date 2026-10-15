/**
 * Google Ads programme 2, G1 (2026-10-15) — google-ads-query: ONE GAQL query a caller writes, run read-only on the
 * business's chosen Google Ads account (GoogleAdsService.Search through the gateway: write-client.ts `liveRows`, one
 * operation). The catch-all so no read is ever missing (Google's own MCP has the same kind of `search` tool).
 *
 * What is checked before anything is sent (a refusal sends nothing):
 *   - one SELECT … FROM … statement (no `;`, quotes closed); GAQL has no write statement, and the search endpoint only
 *     reads, but anything that is not a SELECT is refused here first;
 *   - no other Google Ads account: a resource name of something inside an account (`customers/<id>/campaigns/…`), a
 *     `customer.id` condition and a `customer.resource_name` condition must name this account (the search itself always
 *     goes to this account's own URL). A bare `customers/<id>` elsewhere is a link to another account — a conversion
 *     action's owner, a manager link, a product link — and is accepted;
 *   - what needs more than the tool's own permissions is named (`needs`) for the tool to check: fields that name or
 *     reach people (change_event.user_email, customer_user_access*, lead_form_submission_data, local_services_lead*),
 *     and Google's cost of goods, gross profit and revenue metrics;
 *   - a LIMIT of at most 1,000 rows: added when missing, lowered when higher;
 *   - Google's date rule (developers.google.com/google-ads/api/docs/reporting/segmentation, "Rules for core date segment
 *     fields"): when segments.date, .week, .month, .quarter or .year is SELECTED, the WHERE must hold a finite range of
 *     one of them (BETWEEN, DURING, =, IN, or a lower and an upper bound). Google refuses such a query anyway; the check
 *     says why in plain words before an operation is spent.
 * Everything else (a field that does not exist, a segment Google cannot combine) is Google's to refuse: its error comes
 * back as a sentence.
 */

export const MAX_QUERY_ROWS = 1000
export const DEFAULT_QUERY_ROWS = 200
const MAX_QUERY_LENGTH = 20_000

const CORE_DATE = /\bsegments\.(?:date|week|month|quarter|year)\b/i

/** What a query reads beyond ads numbers: the fields that name or reach people, and cost / profit / revenue metrics. */
export type QueryNeed = 'people' | 'costs' | 'margins' | 'revenue'

export interface CheckedQuery {
  query: string
  /** FROM resource, lower case. */
  from: string
  limit: number
  /** What Nexus changed in the text (a LIMIT added or lowered). */
  notes: string[]
  /** Each kind of sensitive field the query names, with the fields (empty when none). */
  needs: Partial<Record<QueryNeed, string[]>>
}

/** FROM resources that list people (e-mail addresses, leads' contact details, their messages). */
export const PEOPLE_RESOURCES = new Set([
  'customer_user_access', 'customer_user_access_invitation', 'lead_form_submission_data', 'local_services_lead', 'local_services_lead_conversation',
])
const PEOPLE_FIELDS = /\b(?:change_event\.user_email|(?:customer_user_access(?:_invitation)?|lead_form_submission_data|local_services_lead(?:_conversation)?)\.[a-z0-9_.]+)\b/gi
/** Google's metrics from the cart data (v25 metrics page): cost of goods, gross profit (and margin), revenue. */
const MONEY_METRICS: Array<[QueryNeed, RegExp]> = [
  ['costs', /\bmetrics\.[a-z_]*cost_of_goods_sold_micros\b/gi],
  ['margins', /\bmetrics\.[a-z_]*gross_profit_(?:micros|margin)\b/gi],
  ['revenue', /\bmetrics\.[a-z_]*revenue_micros\b/gi],
]

/**
 * Each quoted literal with its inside blanked out (same length, so a position found in the masked text is the same
 * position in the query), and the literals' own text. Null when a quote is not closed.
 */
function masked(text: string): { masked: string; literals: string[] } | null {
  let out = ''
  const literals: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '\'' && ch !== '"') { out += ch; continue }
    let j = i + 1
    let value = ''
    for (; j < text.length && text[j] !== ch; j++) {
      if (text[j] === '\\' && j + 1 < text.length) { value += text[j + 1]; j++; continue }
      value += text[j]
    }
    if (j >= text.length) return null
    literals.push(value)
    out += ch + 'x'.repeat(j - i - 1) + ch
    i = j
  }
  return { masked: out, literals }
}

/**
 * The query as it will be sent, or why it is refused. `customerId` is the business's chosen account (digits).
 */
export function checkedQuery(text: string, customerId: string, defaultLimit: number = DEFAULT_QUERY_ROWS): CheckedQuery | { refusal: string } {
  const refuse = (why: string) => ({ refusal: `${why} Nothing was sent.` })
  const query = String(text ?? '').trim()
  if (!query) return refuse('Give one GAQL query (SELECT … FROM …).')
  if (query.length > MAX_QUERY_LENGTH) return refuse(`The query is longer than ${MAX_QUERY_LENGTH} characters.`)
  const m = masked(query)
  if (!m) return refuse('A quote in the query is not closed.')
  const q = m.masked
  if (q.includes(';')) return refuse('One query only, without `;`.')
  if (!/^SELECT\s/i.test(q)) return refuse('Only a SELECT query reads: google-ads-query never changes anything (the set-google-… tools do, each approved by a person).')
  const from = /\sFROM\s+([a-z_]+)\b/i.exec(q)
  if (!from) return refuse('The query has no FROM resource.')

  // Another account: a resource inside another account, or a condition on the account itself, is refused. A bare
  // `customers/<id>` (a link field: conversion_action.owner_customer, customer_manager_link.manager_customer,
  // product_link.google_ads.customer, …) names a linked account and is accepted.
  const own = String(customerId).replace(/-/g, '')
  const named = new Set<string>()
  for (const literal of m.literals) for (const hit of literal.matchAll(/customers\/(\d+)\/[A-Za-z]/g)) named.add(hit[1])
  const cond = /\bcustomer\.id\s*(?:=|!=|<>|>=|<=|>|<|\bNOT\s+IN\b|\bIN\b)\s*(\([^)]*\)|\d+)/gi
  for (const hit of q.matchAll(cond)) for (const id of hit[1].matchAll(/\d+/g)) named.add(id[0])
  // customer.resource_name = 'customers/<id>' (or IN (…)): the masked text keeps positions, the query holds the values.
  const nameCond = /\bcustomer\.resource_name\s*(?:=|!=|<>|\bNOT\s+IN\b|\bIN\b)\s*(\([^)]*\)|'x*'|"x*")/gi
  for (const hit of q.matchAll(nameCond)) {
    const at = hit.index + hit[0].length - hit[1].length
    for (const id of query.slice(at, at + hit[1].length).matchAll(/customers\/(\d+)/g)) named.add(id[1])
  }
  const other = [...named].filter((id) => id !== own)
  if (other.length) return refuse(`The query names another Google Ads account (${other.join(', ')}): google-ads-query reads only this business's chosen account.`)

  // Google's date rule for a core date segment in the SELECT.
  const select = q.slice(0, from.index)
  const whereMatch = /\sWHERE\s([\s\S]*?)(?=\sORDER\s+BY\s|\sLIMIT\s|\sPARAMETERS\s|$)/i.exec(q)
  const where = whereMatch ? whereMatch[1] : ''
  if (CORE_DATE.test(select)) {
    const finite = /\bsegments\.(?:date|week|month|quarter|year)\s+(?:BETWEEN|DURING|IN)\b/i.test(where)
      || /\bsegments\.(?:date|week|month|quarter|year)\s*=/i.test(where)
      || (/\bsegments\.(?:date|week|month|quarter|year)\s*>=?/i.test(where) && /\bsegments\.(?:date|week|month|quarter|year)\s*<=?/i.test(where))
    if (!finite) {
      return refuse('The query selects a date segment (segments.date, week, month, quarter or year): Google needs a finite range of it in the WHERE (e.g. segments.date BETWEEN \'2026-10-01\' AND \'2026-10-15\', or segments.date DURING LAST_7_DAYS).')
    }
  }

  // LIMIT: at most 1,000 rows; added before PARAMETERS when missing.
  const notes: string[] = []
  const wanted = Math.max(1, Math.min(MAX_QUERY_ROWS, Math.floor(defaultLimit)))
  const limitHit = /\sLIMIT\s+(\d+)\b/i.exec(q)
  let out = query
  let limit: number
  if (limitHit) {
    const asked = Number(limitHit[1])
    if (!(asked >= 1)) return refuse('A LIMIT is 1 or more.')
    limit = Math.min(asked, MAX_QUERY_ROWS)
    if (asked > MAX_QUERY_ROWS) {
      // The masked text keeps every position, so the LIMIT found there is at the same place in the query.
      out = `${query.slice(0, limitHit.index)} LIMIT ${MAX_QUERY_ROWS}${query.slice(limitHit.index + limitHit[0].length)}`
      notes.push(`LIMIT ${asked} lowered to ${MAX_QUERY_ROWS}: google-ads-query answers at most ${MAX_QUERY_ROWS} rows.`)
    }
  } else {
    limit = wanted
    const params = /\sPARAMETERS\s/i.exec(q)
    out = params ? `${query.slice(0, params.index)} LIMIT ${limit}${query.slice(params.index)}` : `${query} LIMIT ${limit}`
    notes.push(`LIMIT ${limit} added.`)
  }
  const needs: CheckedQuery['needs'] = {}
  const fromName = from[1].toLowerCase()
  const people = [...new Set([...q.matchAll(PEOPLE_FIELDS)].map((hit) => hit[0].toLowerCase()))]
  if (PEOPLE_RESOURCES.has(fromName) && !people.length) people.push(fromName)
  if (people.length) needs.people = people
  for (const [need, pattern] of MONEY_METRICS) {
    const fields = [...new Set([...q.matchAll(pattern)].map((hit) => hit[0].toLowerCase()))]
    if (fields.length) needs[need] = fields
  }
  return { query: out, from: fromName, limit, notes, needs }
}
