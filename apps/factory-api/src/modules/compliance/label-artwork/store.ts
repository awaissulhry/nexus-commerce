import type { FactoryClient } from '@nexus/factory-db'
import { DomainError } from '@nexus/factory-domain/core/errors'
import type { ArtworkFact, ArtworkStatus } from '@nexus/factory-domain/compliance/label-artwork/rules'
import type { CommandTx } from '../../../core/command'

/**
 * What the three parts of B-W2b-259 share: the reader type, the artwork rows as the rules read them, and the last line of
 * defence that turns the database's own refusal (B-W2b-218's `compliance: …` artwork guards and `production: …` spoiled-label
 * guards, B-W2b-211's `product: …` BOM guards, a unique key, a reference) into a 409 in words — never a 500.
 */

export type Reader = FactoryClient | CommandTx

export const ARTWORK_SELECT = {
  id: true,
  templateId: true,
  versionNo: true,
  fileId: true,
  status: true,
  authorId: true,
  approvedAt: true,
  approvedById: true,
  retiredAt: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const

export interface ArtworkRow {
  readonly id: string
  readonly templateId: string
  readonly versionNo: number
  readonly fileId: string
  readonly status: ArtworkStatus
  readonly authorId: string | null
  readonly approvedAt: Date | null
  readonly approvedById: string | null
  readonly retiredAt: Date | null
  readonly note: string | null
  readonly version: number
  readonly createdAt: Date
  readonly createdById: string | null
}

/** A label revision's artwork versions, newest first. */
export async function readArtwork(db: Reader, templateId: string): Promise<ArtworkRow[]> {
  return (await db.labelArtworkVersion.findMany({ where: { templateId }, select: ARTWORK_SELECT, orderBy: [{ versionNo: 'desc' }] })) as ArtworkRow[]
}

/** The rules' facts of a row: its author is authorId, else who made the row. */
export const artworkFact = (row: ArtworkRow): ArtworkFact => ({
  id: row.id,
  versionNo: row.versionNo,
  status: row.status,
  authorId: row.authorId ?? row.createdById,
  approvedAt: row.approvedAt,
  approvedById: row.approvedById,
  retiredAt: row.retiredAt,
})

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause
const capital = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`
const PREFIXES = ['compliance: ', 'production: ', 'product: '] as const

/** Runs a write; a database refusal answers 409 in its own words (or the caller's for a unique key or a reference). */
export async function guarded<T>(work: () => Promise<T>, words: { readonly taken?: string; readonly named?: string } = {}): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = causeOf(error)
    const code = (error as { code?: unknown } | null)?.code
    const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : null
    const prefix = message ? PREFIXES.find((entry) => message.startsWith(entry)) : undefined
    if ((cause?.originalCode === '23514' || cause?.originalCode === '23001') && message && prefix) {
      const said = capital(message.slice(prefix.length))
      throw new DomainError('conflict', said.endsWith('.') ? said : `${said}.`, [{ path: 'refusal/DATABASE', message: said }])
    }
    if (code === 'P2002' || cause?.originalCode === '23505') throw new DomainError('conflict', words.taken ?? 'This clashes with a row that exists already: read it again.')
    if (code === 'P2003' || cause?.originalCode === '23503' || cause?.originalCode === '23001') throw new DomainError('conflict', words.named ?? 'Another record still names this one.')
    throw error
  }
}
