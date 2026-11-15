import { isApiError, issuePath } from '../../../../../lib/api/errors'

/**
 * Shipments in depth (B-W2b-410; SCR-066 / SCR-067 and their W2b parts SCR-590 … SCR-598): what every part of this step
 * shares — its catalogue, what the person may do, a refusal's code (`refusal/<CODE>`, the API's issue path) and a failed
 * read or write in this step's own words. Pure: no fetching, no React.
 */

/** This step's catalogue (`messages/<locale>/warehouse-shipments-depth.json`). */
export const DEPTH_NS = 'warehouse-shipments-depth'
/** The catalogues a part of this step draws with (the list frame's words, the W1 shipment words it reuses). */
export const DEPTH_NAMESPACES = [DEPTH_NS, 'shipments', 'lists'] as const

/** A message key of this catalogue and its values. */
export interface Words {
  key: string
  params?: Record<string, string | number>
}
export const words = (key: string, params?: Record<string, string | number>): Words => (params ? { key, params } : { key })

/** What the person may do in this step's parts (each the permission its route asks). */
export interface DepthAbilities {
  view: boolean
  manage: boolean
  pack: boolean
  holdsManage: boolean
  holdsRelease: boolean
  printLabels: boolean
  printDocuments: boolean
  proforma: boolean
  price: boolean
  readFiles: boolean
  uploadFiles: boolean
  viewOrders: boolean
  certificatesView: boolean
}

export function depthAbilitiesOf(permissions: readonly string[]): DepthAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('shipping.view'),
    manage: held.has('shipping.manage'),
    pack: held.has('shipping.pack'),
    holdsManage: held.has('shipping.holds.manage'),
    holdsRelease: held.has('shipping.holds.release'),
    printLabels: held.has('print.labels'),
    printDocuments: held.has('print.documents'),
    proforma: held.has('shipping.proforma.issue'),
    price: held.has('money.price'),
    readFiles: held.has('files.read'),
    uploadFiles: held.has('files.upload'),
    viewOrders: held.has('orders.view'),
    certificatesView: held.has('compliance.certificates.view'),
  }
}

/** The refusal code a 409 names (`refusal/<CODE>`), else null. */
export function refusalOf(error: unknown): string | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    if (match) return match[1]!
  }
  return null
}

/** Every refusal code a 409 names, in order. */
export function refusalsOf(error: unknown): string[] {
  if (!isApiError(error)) return []
  return error.issues.flatMap((issue) => {
    const match = /^refusal\/([A-Z_]+)$/.exec(issuePath(issue))
    return match ? [match[1]!] : []
  })
}

/** A failed read in words (`problem.read.*`). */
export function readWords(error: unknown): Words {
  if (!isApiError(error)) return words('problem.read.internal')
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return words(`problem.read.${error.kind}`)
  return words('problem.read.internal')
}

/**
 * A refused write in words: a refusal code this part knows (`<prefix>.<CODE>`), the record moved meanwhile, a field the
 * request missed, a right the person lacks — never the API's own sentence.
 */
export function writeWords(error: unknown, prefix: string, known: readonly string[]): Words & { reload: boolean } {
  const code = refusalOf(error)
  if (code && known.includes(code)) return { ...words(`${prefix}.${code}`), reload: true }
  if (!isApiError(error)) return { ...words('problem.write.internal'), reload: false }
  if (error.kind === 'conflict') {
    const moved = error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    return { ...words(moved ? 'problem.write.moved' : 'problem.write.state'), reload: true }
  }
  if (error.kind === 'invalid') return { ...words('problem.write.invalid'), reload: false }
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return { ...words(`problem.write.${error.kind}`), reload: error.kind === 'not_found' }
  return { ...words('problem.write.internal'), reload: false }
}

/** A part a screen reads by itself: loading, its value, or why it could not be read. */
export type Read<T> = { readonly state: 'loading' } | { readonly state: 'ready'; readonly value: T } | { readonly state: 'error'; readonly problem: Words }
export const LOADING: Read<never> = Object.freeze({ state: 'loading' })
export const ready = <T,>(value: T): Read<T> => ({ state: 'ready', value })
export const failed = (error: unknown): Read<never> => ({ state: 'error', problem: readWords(error) })

/** A business day (YYYY-MM-DD) as an instant at noon UTC, so a formatter in any zone keeps the day. */
export const dayInstant = (day: string): string => `${day}T12:00:00Z`

/** Live event types this step's parts read again on (a prefix match). */
export const touchesShipment = (change: { type: string; fields: Readonly<Record<string, unknown>> }, shipmentId: string): boolean =>
  (change.type.startsWith('shipment.') || change.type.startsWith('shipping.') || change.type.startsWith('print.job_')) && Object.values(change.fields).some((value) => value === shipmentId || (Array.isArray(value) && value.includes(shipmentId)))
