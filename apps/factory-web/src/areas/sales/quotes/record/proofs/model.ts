import { isProofType, PROOFS_OPEN_STATUSES, proofShapeOf } from '@nexus/factory-domain/sales/quote-proofs/rules'
import type { ProofVersion, QuoteProof, QuoteProofs } from './api'

/**
 * SCR-035-proofs — the quote record's Documents › Proofs (B-W2b-165; SAL-199; design sales.quotes "Documents and files",
 * links.quote sec:proofs): what the panel draws, pure. The current version's proofs may change while it is unsent (the
 * person's role and the version's state say so before any click, in our words); every sent version shows what went to the
 * customer, and an accepted one what the acceptance named (name, version, SHA-256). Nothing here fetches.
 */

export type Words = { key: string; params?: Record<string, string | number> }

/** A proof's bytes as the viewer shows them (a picture's address, a PDF's bytes; null while read). */
export interface Shown {
  src: string | Uint8Array | null
  problem: boolean
}

export interface ProofsPanelModel {
  state: 'loading' | 'error' | 'ready'
  data: QuoteProofs | null
  /** An upload in progress (one at a time). */
  busy: { name: string; step: 'reading' | 'sending' } | null
  /** The last upload, removal or carry-over that went wrong, in our words. */
  problem: Words | null
  notice: Words | null
  /** The proof open in the viewer (a file id), and the bytes read so far by file id. */
  open: string | null
  shown: Readonly<Record<string, Shown>>
  /** The proof whose removal waits for the person's yes. */
  confirmRemove: string | null
  timeZone?: string
}

export interface ProofsPanelActions {
  onRetry?: () => void
  onFiles?: (files: File[]) => void
  onNewVersion?: (fileId: string, file: File) => void
  onRemove?: (fileId: string | null) => void
  onRemoveConfirm?: (fileId: string) => void
  onCarry?: () => void
  onOpen?: (fileId: string | null) => void
  onOpenRetry?: (fileId: string) => void
  onDismiss?: () => void
}

/**
 * The size limits of the files API per kind (apps/factory-api platform/files rules KIND_RULES): a PDF is a DOCUMENT, a
 * picture a PHOTO. Checked before the upload so the person reads the reason at once; the API checks them again.
 */
export const PROOF_MAX_BYTES = { PDF: 25 * 1024 * 1024, PICTURE: 15 * 1024 * 1024 } as const

export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp'

/** The version the office works on. */
export const currentOf = (data: QuoteProofs | null): ProofVersion | null => data?.versions.find((version) => version.current) ?? null

/** Why the current version's proofs cannot change now, in our words; null when they can. */
export function heldOf(data: QuoteProofs | null, busy: boolean): Words | null {
  const current = currentOf(data)
  if (!data || !current) return null
  if (data.may.change) return busy ? { key: 'office.held.busy' } : null
  if (PROOFS_OPEN_STATUSES.includes(current.status)) return { key: 'office.held.right' }
  return current.status === 'SENT' ? { key: 'office.held.frozen', params: { revision: current.revision } } : { key: 'office.held.closed', params: { revision: current.revision } }
}

/** Why one more proof cannot be added (the version is full), or null. */
export function addHeldOf(data: QuoteProofs | null, busy: boolean): Words | null {
  const held = heldOf(data, busy)
  if (held) return held
  const current = currentOf(data)
  if (data && current && current.proofs.length >= data.limits.max) return { key: 'office.held.full', params: { max: data.limits.max } }
  return null
}

/** Why this file cannot be a proof (or the next version of `of`), in our words; null when it can be sent. */
export function fileProblem(file: { name: string; type: string; size: number }, of?: Pick<QuoteProof, 'shape'>): Words | null {
  if (!isProofType(file.type)) return { key: 'office.upload.type', params: { name: file.name } }
  const shape = proofShapeOf(file.type)
  if (of && of.shape !== shape) return { key: 'office.upload.kind' }
  const max = PROOF_MAX_BYTES[shape]
  if (file.size > max) return { key: 'office.upload.size', params: { name: file.name, max: `${max / (1024 * 1024)} MB` } }
  return null
}

/** The versions shown below the current one: those the customer saw (sent, accepted …), newest first. */
export const earlierOf = (data: QuoteProofs | null): ProofVersion[] => (data?.versions ?? []).filter((version) => !version.current)

/** The viewer's proofs of one version (the customer's current version of each). */
export const viewable = (version: ProofVersion | null): QuoteProof[] => (version?.proofs ?? []).filter((proof) => proof.currentFileId !== null)

/** A short document code (the SHA-256's first twelve characters), as the quote PDF's. */
export const codeOf = (sha256: string): string => sha256.slice(0, 12)
