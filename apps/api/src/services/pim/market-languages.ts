import prisma from '../../db.js'

export interface MarketLanguageRow {
  channel: string
  code: string
  languages: readonly string[]
  /** Compatibility for rows created by an older deployed writer. */
  language?: string
}

const marketCode = (code: string) => code.toUpperCase() === 'GB' ? 'UK' : code.toUpperCase()

/** Ordered content languages from the workspace-scoped Marketplace row. Loaded
 * rows may be supplied by batch callers to avoid a query for every product. */
export function marketLanguages(channel: string, code: string, rows: readonly MarketLanguageRow[]): string[]
export function marketLanguages(channel: string, code: string): Promise<string[]>
export function marketLanguages(channel: string, code: string, rows?: readonly MarketLanguageRow[]): string[] | Promise<string[]> {
  const coordinate = { channel: channel.toUpperCase(), code: marketCode(code) }
  const read = (row: Pick<MarketLanguageRow, 'languages' | 'language'> | null | undefined) => {
    // Older deployed seeders can still insert the scalar with an empty new array.
    // New writers populate both; this fallback does not create another language map.
    const values = row?.languages?.length ? [...row.languages] : row?.language ? [row.language.toLowerCase()] : []
    if (!values.length) throw new Error(`No content languages configured for ${coordinate.channel}/${coordinate.code}.`)
    return values
  }
  if (rows) return read(rows.find(row => row.channel === coordinate.channel && row.code === coordinate.code))
  return prisma.marketplace.findFirst({ where: coordinate, select: { languages: true, language: true } }).then(read)
}

/** Regional serialization only; the language is supplied by the authority or
 * by an explicitly selected language from that row. UK's region is ISO GB. */
export function languageTag(language: string, code: string): string {
  if (!/^[a-z]{2,3}$/i.test(language) || !/^[a-z]{2}$/i.test(code)) throw new Error('A language and two-letter marketplace code are required for a regional language tag.')
  return `${language.toLowerCase()}_${code.toUpperCase() === 'UK' ? 'GB' : code.toUpperCase()}`
}

/** A representative Amazon market for an AI request, selected from the same
 * authority. Prefer a monolingual row before a multilingual fallback. */
export async function marketplaceForLanguage(language: string): Promise<string> {
  const rows = await prisma.marketplace.findMany({ where: { channel: 'AMAZON', isActive: true }, select: { channel: true, code: true, languages: true, language: true }, orderBy: { code: 'asc' } })
  const matches = rows.filter(row => marketLanguages(row.channel, row.code, [row]).includes(language.toLowerCase()))
  const row = matches.find(row => marketLanguages(row.channel, row.code, [row]).length === 1) ?? matches[0]
  if (!row) throw new Error(`No Amazon marketplace is configured for ${language}.`)
  return row.code
}

export async function availableContentLanguages(): Promise<string[]> {
  const markets = await prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, languages: true, language: true } })
  return [...new Set(markets.flatMap(row => marketLanguages(row.channel, row.code, [row])))]
}
