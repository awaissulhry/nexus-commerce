/**
 * P4.6c — stock and price on Etsy, which are one endpoint and one read-modify-write.
 *
 * `PUT /listings/{listing_id}/inventory` is the only way to change a quantity or a price on Etsy,
 * and it is a **full replace**. Etsy staff, on their own board: *"You cannot update a single
 * ListingInventory record; you must perform a PUT and include the entire dataset of your
 * inventory."* So every quantity change sends every offering of that listing back, including
 * prices we are not changing.
 *
 * That makes the transform below the whole job, and it has three traps, all of them measured
 * against Etsy's published OpenAPI document (`etsy.com/openapi/generated/oas/3.0.0.json`, read
 * 2026-09-21) rather than against a blog post or our own belief.
 *
 * ## Trap 1 — the answer cannot be sent back as it arrived
 *
 * The GET and the PUT are different shapes, and Etsy *strictly* interprets the JSON: an extra key
 * is a 400, `"Array contains invalid keys: product_id,is_deleted"`.
 *
 * | level | GET returns | PUT accepts | so we strip |
 * |---|---|---|---|
 * | product | `product_id`, `sku`, `is_deleted`, `offerings`, `property_values` | `sku`, `property_values`, `offerings` | `product_id`, `is_deleted` |
 * | offering | `offering_id`, `quantity`, `is_enabled`, `is_deleted`, `price`, `readiness_state_id` | `price`, `quantity`, `is_enabled`, `readiness_state_id` | `offering_id`, `is_deleted` |
 * | property value | …, `scale_name`, … | `property_id`, `value_ids`, `values`, `scale_id`, `property_name` | `scale_name` |
 *
 * ## Trap 2 — `price` changes TYPE between the read and the write of the same field
 *
 * The GET returns `price` as a **Money object** (`{amount, divisor, currency_code}`); the PUT
 * wants a **number**. Sending the object back is a 400, and sending `amount` is a hundredfold
 * overcharge. `moneyToNumber` converts by the divisor and rounds to the divisor's own precision,
 * so a 2-decimal currency never leaves through a float artefact.
 *
 * ## Trap 3 🔴 — a correct, successful write can destroy a price, and we cannot see it coming
 *
 * A shop with Etsy's **domestic + international pricing** loses its domestic price on any
 * inventory PUT: the feature is switched off and the domestic field is blanked. Reported on
 * Etsy's board since 2023 and **still open in August 2026**, and Etsy staff do not read that
 * board.
 *
 * There is no way to avoid it and no way to predict it:
 *
 * - **The API never exposes it.** `getListing` and `getListingInventory` both return a single
 *   price per offering. Nothing in the OpenAPI document names the feature — verified by searching
 *   the whole 908 KB document, not by reading the endpoints we happened to use.
 * - **A country allowlist would be a lie.** The feature is offered in some shop regions and not
 *   others, and a hardcoded list of them is exactly the banked *"a list of members is a SET
 *   CLAIM"* trap: it would be stale within months and would read as a measurement.
 *
 * So this module does not pretend to predict it. It does three things instead:
 *
 * 1. **It never invents a price.** Every offering we are not deliberately changing is sent back
 *    with the price Etsy itself just returned. That is the minimum-damage write.
 * 2. **It reads back and compares** (the quality bar §7.1.12). Every offering is checked against
 *    what we sent, and a field that moved when we did not move it is a finding, not a log line.
 * 3. **The publish gate is the acknowledgement.** `NEXUS_ENABLE_ETSY_PUBLISH` is off by default
 *    and turning it on is the Owner's deliberate act. A second per-account consent switch would
 *    be a second thing to forget, not a second safeguard.
 */

/** Etsy's Money: `amount / divisor` in `currency_code`. */
export interface EtsyMoney {
  amount: number
  divisor: number
  currency_code?: string
}

export interface EtsyReadOffering {
  offering_id?: number
  quantity?: number
  is_enabled?: boolean
  is_deleted?: boolean
  price?: EtsyMoney | number
  readiness_state_id?: number | null
}

export interface EtsyReadPropertyValue {
  property_id?: number
  property_name?: string | null
  scale_id?: number | null
  scale_name?: string | null
  value_ids?: number[]
  values?: string[]
}

export interface EtsyReadProduct {
  product_id?: number
  sku?: string
  is_deleted?: boolean
  offerings?: EtsyReadOffering[]
  property_values?: EtsyReadPropertyValue[]
}

export interface EtsyReadInventory {
  products?: EtsyReadProduct[]
  price_on_property?: number[]
  quantity_on_property?: number[]
  sku_on_property?: number[]
  readiness_state_on_property?: number[]
}

export interface EtsyWriteOffering {
  price: number
  quantity: number
  is_enabled: boolean
  readiness_state_id?: number | null
}

export interface EtsyWriteProduct {
  sku?: string
  property_values?: Array<{ property_id: number; value_ids: number[]; values: string[]; scale_id?: number | null; property_name?: string }>
  offerings: EtsyWriteOffering[]
}

export interface EtsyInventoryWrite {
  products: EtsyWriteProduct[]
  price_on_property?: number[]
  quantity_on_property?: number[]
  sku_on_property?: number[]
  readiness_state_on_property?: number[]
}

export class EtsyInventoryShapeError extends Error {
  constructor(message: string) { super(message); this.name = 'EtsyInventoryShapeError' }
}

/**
 * Etsy's Money as the number the PUT wants.
 *
 * 🔴 Two ways to get this wrong, both on the money path: sending `amount` (a hundredfold
 * overcharge) and letting binary floating point through (`amount/divisor` for 1999/100 prints
 * fine, but a chain of them does not). The result is rounded to the divisor's own number of
 * decimal places — 100 → 2, 1000 → 3 — so the value sent is the value Etsy stated.
 */
export function moneyToNumber(price: EtsyMoney | number | undefined, where: string): number {
  if (typeof price === 'number') {
    if (!Number.isFinite(price) || price < 0) throw new EtsyInventoryShapeError(`${where}: the price is not a usable number; nothing was sent.`)
    return price
  }
  if (!price || typeof price !== 'object') throw new EtsyInventoryShapeError(`${where}: Etsy returned no price; nothing was sent.`)
  const { amount, divisor } = price
  if (!Number.isFinite(amount) || !Number.isInteger(divisor) || divisor <= 0) {
    throw new EtsyInventoryShapeError(`${where}: Etsy's price could not be read (amount=${String(amount)}, divisor=${String(divisor)}); nothing was sent.`)
  }
  // Etsy's divisor is a power of ten in every currency it lists (100 for two decimals, 1000 for
  // three). That is not ASSUMED here: a power of ten is rounded to its own precision, and anything
  // else falls back to six decimals — enough to erase a float artefact without inventing precision.
  const log = Math.log10(divisor)
  const decimals = Number.isInteger(log) ? Math.max(0, Math.min(6, log)) : 6
  return Number((amount / divisor).toFixed(decimals))
}

/**
 * The GET answer as the PUT body: read-only keys stripped, prices converted, deleted rows dropped.
 *
 * Deleted products and offerings are **left out**, not echoed. `is_deleted` is a state Etsy
 * reports and the PUT has no field for; sending one back either resurrects it or is refused, and
 * neither is what a stock sync meant to do.
 */
export function toInventoryWrite(read: EtsyReadInventory): EtsyInventoryWrite {
  const products = (read.products ?? []).filter((p) => p.is_deleted !== true)
  if (products.length === 0) throw new EtsyInventoryShapeError('Etsy returned no live products for this listing; nothing was sent.')

  const write: EtsyInventoryWrite = {
    products: products.map((product, pi) => {
      const offerings = (product.offerings ?? []).filter((o) => o.is_deleted !== true)
      if (offerings.length === 0) {
        throw new EtsyInventoryShapeError(`Etsy product ${product.sku || `#${pi + 1}`} has no live offering; nothing was sent.`)
      }
      const out: EtsyWriteProduct = {
        offerings: offerings.map((offering, oi) => {
          const where = `Etsy product ${product.sku || `#${pi + 1}`}, offering #${oi + 1}`
          if (!Number.isInteger(offering.quantity) || (offering.quantity as number) < 0) {
            throw new EtsyInventoryShapeError(`${where}: Etsy returned no usable quantity; nothing was sent.`)
          }
          const o: EtsyWriteOffering = {
            price: moneyToNumber(offering.price, where),
            quantity: offering.quantity as number,
            // `is_enabled` is required by the PUT. Etsy omitting it would silently DISABLE the
            // offering if we defaulted to false, so an absent value is a refusal, not a default.
            is_enabled: assertBoolean(offering.is_enabled, `${where}: Etsy returned no is_enabled flag`),
          }
          // Nullable in both directions: a listing with no processing profile has none, and null
          // is a legal value the PUT accepts. Absent and null are the same fact here.
          if (offering.readiness_state_id !== undefined) o.readiness_state_id = offering.readiness_state_id
          return o
        }),
      }
      if (product.sku !== undefined) out.sku = product.sku
      if (product.property_values !== undefined) {
        out.property_values = product.property_values.map((pv) => {
          const value: NonNullable<EtsyWriteProduct['property_values']>[number] = {
            property_id: Number(pv.property_id),
            value_ids: pv.value_ids ?? [],
            values: pv.values ?? [],
          }
          // `scale_name` is returned by the GET and REFUSED by the PUT — one of the four keys in
          // Etsy's own "Array contains invalid keys" error. `scale_id` is the one that is kept.
          if (pv.scale_id !== undefined) value.scale_id = pv.scale_id
          if (pv.property_name != null) value.property_name = pv.property_name
          return value
        })
      }
      return out
    }),
  }
  // The four *_on_property arrays describe which properties vary price / quantity / sku /
  // readiness. They are echoed exactly: dropping one flattens a variation listing into a single
  // price, which is a far larger change than the quantity we came to make.
  for (const key of ['price_on_property', 'quantity_on_property', 'sku_on_property', 'readiness_state_on_property'] as const) {
    if (read[key] !== undefined) write[key] = read[key]
  }
  return write
}

function assertBoolean(value: boolean | undefined, message: string): boolean {
  if (typeof value !== 'boolean') throw new EtsyInventoryShapeError(`${message}; nothing was sent.`)
  return value
}

export interface OfferingChange {
  /** The product's SKU. A listing with no variations has one product, which may have no SKU. */
  sku?: string | null
  /** Which offering of that product, when it has more than one. Defaults to the only one. */
  offeringIndex?: number
  quantity?: number
  price?: number
}

export class EtsyOfferingNotFound extends Error {
  constructor(message: string) { super(message); this.name = 'EtsyOfferingNotFound' }
}

/**
 * 2026-09-30 — a price Etsy's own inventory cannot take for this SKU alone, or in this currency. Raised before the
 * PUT, so nothing was sent.
 */
export class EtsyPriceRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'EtsyPriceRefusal' }
}

/**
 * 2026-10-01 — a stock number Nexus will not send to this Etsy listing: the SKU is on more than one Etsy product, the
 * listing has one quantity for all its variations, or Etsy order import is off. Raised before the PUT, so nothing was
 * sent, and a retry gives the same answer.
 */
export class EtsyQuantityRefusal extends Error {
  readonly code = 'ETSY_QUANTITY_REFUSED'
  constructor(message: string) { super(message); this.name = 'EtsyQuantityRefusal' }
}

/**
 * Etsy's ceiling for one offering's quantity. The OpenAPI document sets no maximum on the field; 999 is the most
 * Etsy lets a seller list of one item (Etsy's seller help), so a higher number is sent as 999 and the clamp is reported.
 */
export const ETSY_MAX_OFFERING_QUANTITY = 999

/** A quantity sent lower than asked, because Etsy holds at most `ETSY_MAX_OFFERING_QUANTITY`. */
export interface EtsyQuantityClamp {
  sku: string | null
  requested: number
  sent: number
}

/**
 * Etsy answered, and its inventory does not allow the change: the SKU is not there, the data cannot be read, or the
 * price or stock number cannot be set for this SKU alone. Nothing was sent, and the same inventory gives the same
 * answer on a retry. A failed READ is not one of these; it is retryable.
 */
export function isEtsyInventoryRefusal(error: unknown): boolean {
  return error instanceof EtsyOfferingNotFound || error instanceof EtsyInventoryShapeError || error instanceof EtsyPriceRefusal
    || error instanceof EtsyQuantityRefusal
}

/**
 * 🔴 2026-09-30 — the currency check for a price.
 *
 * The PUT takes a bare number, and Etsy reads it in the shop's currency. Nexus holds the price in the listing
 * market's currency (`Marketplace.currency`). The only place the two meet is the read made just before the write, where
 * Etsy states `currency_code` on every price. A different currency, or none stated, is refused: a price is never
 * converted, and a number sent in the wrong currency is a money defect no Etsy error would report.
 */
export function etsyPriceCurrencyRefusal(read: EtsyReadInventory, currency: string | null | undefined): string | null {
  const wanted = (currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(wanted)) return 'A price for Etsy must say which currency it is in; nothing was sent.'
  const stated = new Set<string>()
  for (const product of read.products ?? []) {
    if (product.is_deleted === true) continue
    for (const offering of product.offerings ?? []) {
      if (offering.is_deleted === true) continue
      const code = typeof offering.price === 'object' && offering.price ? String(offering.price.currency_code ?? '').trim().toUpperCase() : ''
      if (!code) return `Etsy did not state the currency of this listing's prices, so Nexus cannot tell that ${wanted} is right; nothing was sent.`
      stated.add(code)
    }
  }
  const other = [...stated].filter((code) => code !== wanted)
  if (other.length > 0) {
    return `Etsy prices this listing in ${[...stated].sort().join(', ')}, and Nexus holds this price in ${wanted}. A price is never converted, so nothing was sent.`
  }
  return null
}

/** The value a product has for each property its price depends on: products with the same key share one price on Etsy. */
function priceGroupKey(product: EtsyWriteProduct, priceProperties: readonly number[]): string {
  return priceProperties.map((id) => {
    const value = product.property_values?.find((pv) => pv.property_id === id)
    return value ? `${id}=${value.value_ids.join('+')}/${value.values.join('+')}` : `${id}=?`
  }).join('|')
}

/**
 * 🔴 2026-09-30 — a price change may not split a price Etsy keeps as one.
 *
 * Etsy's price depends only on the properties in `price_on_property` ("The `*_on_property` values should match the
 * `property_id` values, but only if those properties affect the sku, quantity, price…" — Etsy's listings tutorial).
 * With it empty, every variation of the listing has the one price; with `[size]`, every product of one size has one
 * price whatever its colour. So a price for one SKU alone is only a price Etsy can hold when no other product shares
 * its price group. Otherwise the choice is to change the other variations too (a price nobody asked for) or to send a
 * split Etsy's own model does not allow. Neither is sent: the change is refused by name, before the PUT.
 */
function assertPriceGroupsWhole(before: EtsyInventoryWrite, after: EtsyInventoryWrite): void {
  const priceProperties = after.price_on_property ?? []
  after.products.forEach((product, pi) => {
    const moved = product.offerings.some((offering, oi) => offering.price !== before.products[pi]?.offerings[oi]?.price)
    if (!moved) return
    const key = priceGroupKey(product, priceProperties)
    const group = after.products.filter((other) => priceGroupKey(other, priceProperties) === key)
    const prices = new Set(group.flatMap((other) => other.offerings.map((offering) => offering.price)))
    if (prices.size > 1) {
      const name = product.sku ? `"${product.sku}"` : `product #${pi + 1}`
      const others = group.length - 1
      throw new EtsyPriceRefusal(priceProperties.length === 0
        ? `On Etsy this listing has one price for all its ${after.products.length} variations, so a price for ${name} alone cannot be sent without changing the other ${others}; nothing was sent.`
        : `On Etsy ${name} shares its price with ${others} other variation(s) (the price varies only by property ${priceProperties.join(', ')}), so a price for it alone cannot be sent; nothing was sent.`)
    }
  })
}

/**
 * 🔴 2026-10-01 — a stock number may not split a quantity Etsy keeps as one. The same rule as prices, on
 * `quantity_on_property`: "The update fails if the supplied values for product sku, offering quantity, price, and/or
 * processing profile are incompatible with values in `*_on_property` fields" (updateListingInventory), and in Etsy's
 * listings tutorial "when quantity is updated it must be the same value across all products sharing" it. Refused
 * before the PUT: Etsy would refuse it anyway, and a retry would only ask again.
 */
function assertQuantityGroupsWhole(before: EtsyInventoryWrite, after: EtsyInventoryWrite): void {
  const quantityProperties = after.quantity_on_property ?? []
  // The values a product has for the properties its quantity depends on. A product that states no value for one of
  // them cannot be placed in a group, so it is its own: this check never refuses on a guess.
  const keyOf = (product: EtsyWriteProduct, pi: number): string => {
    const values = quantityProperties.map((id) => product.property_values?.find((pv) => pv.property_id === id))
    if (values.some((value) => !value)) return `#${pi}`
    return values.map((value, i) => `${quantityProperties[i]}=${value!.value_ids.join('+')}/${value!.values.join('+')}`).join('|')
  }
  after.products.forEach((product, pi) => {
    const moved = product.offerings.some((offering, oi) => offering.quantity !== before.products[pi]?.offerings[oi]?.quantity)
    if (!moved) return
    const key = keyOf(product, pi)
    const group = after.products.filter((other, oi) => keyOf(other, oi) === key)
    const quantities = new Set(group.flatMap((other) => other.offerings.map((offering) => offering.quantity)))
    if (quantities.size > 1) {
      const name = product.sku ? `"${product.sku}"` : `product #${pi + 1}`
      throw new EtsyQuantityRefusal(`On Etsy ${name} shares its quantity with ${group.length - 1} other variation(s) (the quantity varies only by property ${quantityProperties.join(', ')}), so a stock number for it alone cannot be sent; nothing was sent.`)
    }
  })
}

/**
 * Apply changes to a write body. Returns a NEW body — the original is the record of what Etsy
 * held, and the read-back compares against it.
 *
 * A change that matches nothing is an **error**, never a quiet no-op: "the SKU is not on this
 * listing" and "the quantity was already right" are different facts, and a silent miss is how a
 * stock sync reports success while changing nothing.
 */
export function applyOfferingChanges(
  body: EtsyInventoryWrite,
  changes: readonly OfferingChange[],
  /** Collects every quantity sent lower than asked (Etsy's ceiling), so the caller can say so. */
  report?: { clamped: EtsyQuantityClamp[] },
): EtsyInventoryWrite {
  const next: EtsyInventoryWrite = { ...body, products: body.products.map((p) => ({ ...p, offerings: p.offerings.map((o) => ({ ...o })) })) }
  for (const change of changes) {
    const matches = change.sku == null
      ? next.products
      : next.products.filter((p) => p.sku === change.sku)
    if (matches.length === 0) {
      throw new EtsyOfferingNotFound(`Etsy has no product with SKU "${change.sku}" on this listing; nothing was sent.`)
    }
    if (change.sku == null && next.products.length > 1) {
      throw new EtsyOfferingNotFound('This Etsy listing has more than one product, so a change must name its SKU; nothing was sent.')
    }
    // 2026-09-30 — one SKU on several Etsy products that Etsy prices differently: Nexus holds ONE price for the SKU and
    // will not pick which of Etsy's prices it means, nor flatten them into one.
    if (change.price !== undefined && matches.length > 1) {
      const index = change.offeringIndex ?? 0
      const held = new Set(matches.map((p) => p.offerings[index]?.price))
      if (held.size > 1) {
        throw new EtsyPriceRefusal(`Etsy has ${matches.length} products with SKU "${change.sku}" at different prices; Nexus holds one price for that SKU and will not choose between them, so nothing was sent.`)
      }
    }
    if (change.quantity !== undefined) {
      // 2026-10-01 (Owner) — Nexus holds ONE stock number for a SKU. Etsy may carry that SKU on several products
      // (its SKU can vary by fewer properties than its quantity); writing the number onto each of them would count
      // the same units once per product.
      if (matches.length > 1) {
        throw new EtsyQuantityRefusal(`Etsy has ${matches.length} products with SKU "${change.sku}" on this listing; Nexus holds one stock number for that SKU and will not put it on each of them, so nothing was sent.`)
      }
      // A listing whose quantity does not vary by any property has ONE quantity for every variation: a stock number
      // for one SKU would either change all of them or split what Etsy keeps as one.
      if (next.products.length > 1 && (body.quantity_on_property ?? []).length === 0) {
        const name = change.sku == null ? 'one variation' : `"${change.sku}"`
        throw new EtsyQuantityRefusal(`On Etsy this listing has one quantity for all its ${next.products.length} variations, so a stock number for ${name} alone cannot be sent without changing the other ${next.products.length - 1}; nothing was sent.`)
      }
    }
    for (const product of matches) {
      const index = change.offeringIndex ?? 0
      const offering = product.offerings[index]
      if (!offering) {
        throw new EtsyOfferingNotFound(`Etsy product "${product.sku ?? ''}" has no offering #${index + 1}; nothing was sent.`)
      }
      if (change.quantity !== undefined) {
        if (!Number.isInteger(change.quantity) || change.quantity < 0) {
          throw new EtsyOfferingNotFound(`A quantity of ${change.quantity} is not a whole number of items; nothing was sent.`)
        }
        const sent = Math.min(change.quantity, ETSY_MAX_OFFERING_QUANTITY)
        if (sent !== change.quantity) report?.clamped.push({ sku: product.sku ?? null, requested: change.quantity, sent })
        offering.quantity = sent
      }
      if (change.price !== undefined) {
        if (!Number.isFinite(change.price) || change.price <= 0) {
          throw new EtsyOfferingNotFound(`A price of ${change.price} is not a usable price; nothing was sent.`)
        }
        offering.price = change.price
      }
    }
  }
  if (changes.some((change) => change.price !== undefined)) assertPriceGroupsWhole(body, next)
  if (changes.some((change) => change.quantity !== undefined)) assertQuantityGroupsWhole(body, next)
  return next
}

export interface InventoryDrift {
  product: string
  offering: number
  field: 'price' | 'quantity' | 'is_enabled'
  sent: number | boolean
  found: number | boolean
}

/**
 * The read-back (quality bar §7.1.12): what we sent, against what Etsy holds afterwards.
 *
 * 🔴 This is the only instrument that can see trap 3. A shop with regional pricing loses its
 * domestic price on a PUT that answers 200, so the write's own RESPONSE cannot report it —
 * banked: *a claim must match its MEASUREMENT, and a write's response is not what it wrote.*
 *
 * A row here means Etsy holds something other than what we sent. It is reported, never repaired:
 * a second PUT to "fix" a price Etsy moved is another full replace, and the thing that went wrong
 * is exactly the thing a retry would do again.
 */
export function inventoryDrift(sent: EtsyInventoryWrite, found: EtsyReadInventory): InventoryDrift[] {
  const drift: InventoryDrift[] = []
  let afterWrite: EtsyInventoryWrite
  try {
    afterWrite = toInventoryWrite(found)
  } catch {
    // The read-back could not be read. That is "could not measure", not "measured equal" — the
    // caller is told by the empty-with-error path, never by a clean [].
    throw new EtsyInventoryShapeError('The Etsy read-back could not be read, so the change could not be confirmed.')
  }
  sent.products.forEach((product, pi) => {
    const mirror = product.sku != null
      ? afterWrite.products.find((p) => p.sku === product.sku)
      : afterWrite.products[pi]
    const name = product.sku || `#${pi + 1}`
    if (!mirror) {
      drift.push({ product: name, offering: 0, field: 'quantity', sent: product.offerings[0]?.quantity ?? -1, found: -1 })
      return
    }
    product.offerings.forEach((offering, oi) => {
      const other = mirror.offerings[oi]
      if (!other) {
        drift.push({ product: name, offering: oi + 1, field: 'quantity', sent: offering.quantity, found: -1 })
        return
      }
      if (other.price !== offering.price) drift.push({ product: name, offering: oi + 1, field: 'price', sent: offering.price, found: other.price })
      if (other.quantity !== offering.quantity) drift.push({ product: name, offering: oi + 1, field: 'quantity', sent: offering.quantity, found: other.quantity })
      if (other.is_enabled !== offering.is_enabled) drift.push({ product: name, offering: oi + 1, field: 'is_enabled', sent: offering.is_enabled, found: other.is_enabled })
    })
  })
  return drift
}
