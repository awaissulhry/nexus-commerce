/**
 * A purchase order's acknowledgement link tokens are secrets. `supplierAckToken` is in the link e-mailed to the
 * supplier, `approverAckToken` in the one e-mailed to the approver: whoever holds one acknowledges or approves the PO
 * without signing in. They stay in the database for those links and leave it in no answer — they were in every PO
 * answer, so anyone with po.view could read them. The web never used them.
 */

/** Prisma `omit` for a PurchaseOrder read (a query, or an include of one). */
export const PO_SECRET_OMIT = { supplierAckToken: true, approverAckToken: true } as const

const SECRET_KEYS = new Set(Object.keys(PO_SECRET_OMIT))

/**
 * The payload without the token keys, anywhere in it (a PO in a list, a supplier's POs, a shipment's PO). Only plain
 * objects and arrays are walked; anything else (a Date, a Buffer, a string) is returned as it is. A payload with no
 * such key is returned unchanged, not copied.
 */
export function withoutPoSecrets<T>(payload: T): T {
  return strip(payload, 0) as T
}

function strip(value: unknown, depth: number): unknown {
  if (value == null || typeof value !== 'object' || depth > 32) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = strip(item, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      changed = true
      continue
    }
    const next = strip(item, depth + 1)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}
