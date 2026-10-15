/**
 * Google Ads programme 2, G1 (2026-10-15) — google-ads-query: ONE GAQL query a caller writes, run read-only on the
 * business's chosen Google Ads account (GoogleAdsService.Search through the gateway: write-client.ts `liveRows`, one
 * operation). The catch-all so no read is ever missing (Google's own MCP has the same kind of `search` tool).
 *
 * What is checked before anything is sent (a refusal sends nothing):
 *   - one SELECT … FROM … statement (no `;`, quotes closed); GAQL has no write statement, and the search endpoint only
 *     reads, but anything that is not a SELECT is refused here first;
 *   - no other Google Ads account: a `customers/<id>` resource name or a `customer.id` condition must name this
 *     account (the search itself always goes to this account's own URL);
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

export interface CheckedQuery {
  query: string
  /** FROM resource, lower case. */
  from: string
  limit: number
  /** What Nexus changed in the text (a LIMIT added or lowered). */
  notes: string[]
}

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

  // Another account: resource names in literals and customer.id conditions must name this one.
  const own = String(customerId).replace(/-/g, '')
  const named = new Set<string>()
  for (const literal of m.literals) for (const hit of literal.matchAll(/customers\/(\d+)/g)) named.add(hit[1])
  const cond = /\bcustomer\.id\s*(?:=|!=|<>|>=|<=|>|<|\bNOT\s+IN\b|\bIN\b)\s*(\([^)]*\)|\d+)/gi
  for (const hit of q.matchAll(cond)) for (const id of hit[1].matchAll(/\d+/g)) named.add(id[0])
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
  return { query: out, from: from[1].toLowerCase(), limit, notes }
}

/** FROM resources that list people (e-mail addresses): they need the users permission too. */
export const PEOPLE_RESOURCES = new Set(['customer_user_access', 'customer_user_access_invitation'])
