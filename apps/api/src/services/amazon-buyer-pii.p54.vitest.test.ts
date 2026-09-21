/**
 * P5.4 — Amazon buyer personal data: we do not ask for it, so we do not hold it.
 *
 * Plan row: *"Amazon buyer data: use a Restricted Data Token where we read buyer
 * personal data — **or stop reading it if we do not need it**."*
 *
 * ## The answer is the second branch, and it is measured
 *
 * Amazon redacts buyer PII from `getOrders` / `getOrder` unless the call carries a
 * **Restricted Data Token** (`POST /tokens/2021-03-01/restrictedDataToken`). Nexus has
 * never minted one: `createRestrictedDataToken` occurs **once** in the entire
 * codebase, inside the gateway's list of read-shaped POST operations — a name in a
 * `Set`, with no call site.
 *
 * Development database, 2026-09-21, **4,464** Amazon orders:
 *
 * | column | rows with a value |
 * |---|---|
 * | `customerEmail` | **0** |
 * | `customerId` | **0** |
 * | `customerName` | 4,464 — **every one the literal string `'Amazon customer'`** |
 * | `shippingAddress` present | 3,908 |
 * | `shippingAddress` with `AddressLine1` | **0** |
 *
 * The stored address keys are `City, CountryCode, PostalCode, StateOrRegion` (and
 * occasionally `County`, `CompanyName`) — exactly the non-personal subset Amazon
 * returns without an RDT, and what shipping cost and tax need.
 *
 * **So no Amazon buyer personal data is stored anywhere.** The row is complete without
 * building anything.
 *
 * ## 🔴 What this test is actually for
 *
 * The risk runs the other way. Three readers (`pickCustomerName`,
 * `pickCustomerEmail`, and the `ShippingAddress` store) are written as if PII will
 * arrive. If an RDT is ever added — for a genuine reason, or by someone "completing"
 * those readers — `customerEmail` silently starts filling with real buyer addresses,
 * into a column with no retention rule, no field-security decision and no operator
 * awareness.
 *
 * This holds the decision. Minting an RDT becomes a visible diff that has to carry a
 * reason, rather than a side effect.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Real code lines only — a comment naming the operation is documentation. */
const codeLines = (src: string) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))

describe('Restricted Data Token (P5.4 — the decision, held)', () => {
  const files = walk(SRC).filter((f) => !f.endsWith('.test.ts'))

  it('nothing mints a Restricted Data Token', () => {
    const hits: string[] = []
    for (const file of files) {
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (/restrictedDataToken|restricted_data_token/i.test(line)) {
          // The gateway's operation-name Set is the ONE allowed occurrence: it
          // classifies the operation as read-shaped, it does not call it.
          if (file.endsWith('gateway/amazon-sdk.ts') && line.includes("'createRestrictedDataToken'")) continue
          hits.push(`${file.replace(SRC, 'src')}: ${line.trim().slice(0, 120)}`)
        }
      }
    }
    expect(
      hits,
      'A Restricted Data Token makes Amazon send real buyer PII into Order.customerEmail / ' +
        'shippingAddress. If that is intended, say why here and give the data a retention rule ' +
        `first — see build/P5.4.md:\n${hits.join('\n')}`,
    ).toEqual([])
  })

  it('positive control: the gateway DOES still name the operation', () => {
    // Without this, the census above passes just as well if the string vanished and
    // the pattern stopped matching anything at all.
    const sdk = readFileSync(join(SRC, 'services', 'gateway', 'amazon-sdk.ts'), 'utf8')
    expect(codeLines(sdk).filter((l) => l.includes("'createRestrictedDataToken'"))).toHaveLength(1)
  })

  it('no SP-API call sends an RDT as its access token', () => {
    // The other shape: an RDT minted elsewhere and passed as `x-amz-access-token`.
    const hits: string[] = []
    for (const file of files) {
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (/x-amz-access-token/i.test(line) && /rdt|restricted/i.test(line)) {
          hits.push(`${file.replace(SRC, 'src')}: ${line.trim().slice(0, 120)}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})

describe('the readers that would receive it (P5.4)', () => {
  const orders = readFileSync(join(SRC, 'services', 'amazon-orders.service.ts'), 'utf8')

  it('the fallback that all 4,464 stored names actually came from is still there', () => {
    expect(orders).toContain("'Amazon customer'")
  })

  it('the email reader still yields an empty string, not a null or a placeholder', () => {
    // 0 of 4,464 rows have an email. If this ever returns something else, the column
    // starts holding personal data.
    expect(orders).toContain("return order.BuyerInfo?.BuyerEmail ?? ''")
  })

  it('the decision is written where the readers are, not only in a document', () => {
    expect(orders).toMatch(/P5\.4 — buyer personal data/)
    expect(orders).toMatch(/Restricted Data Token/)
  })
})
