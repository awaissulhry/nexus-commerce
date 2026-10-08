/**
 * Step 4 Send to FBA (Owner 2026-10-07, plan §4f) — the ship-from address Amazon's createInboundPlan needs
 * (AddressInput: name, addressLine1, city, postalCode, countryCode, phoneNumber are required).
 *
 * It comes from two places Nexus already keeps, never from code and never guessed:
 *   - the From warehouse's address (`Warehouse` linked to the From StockLocation: street, more address, town, postal
 *     code, country) — filled in Locations;
 *   - the company's name and phone (`companyIdentity`, Settings › Company; for the original business the NEXUS_ISSUER_*
 *     settings fill an empty field, as for its documents).
 * A missing field is named in `check.missing` (the dialog's Banner says where to fill it) and the plan is refused
 * (`sendProblems` → NO_ADDRESS). There is no fallback address, no env override and no placeholder.
 */
import type { FbaAddressCheck, FbaSourceAddress } from '@nexus/shared/fba-send'
import { addressMissing } from '@nexus/shared/fba-send'
import { companyIdentity, requireCompanyIdentity } from '../business-identity.service.js'

/** The From warehouse's address fields (null = not linked to a Warehouse row, or the field is empty). */
export interface WarehouseAddress {
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postalCode: string | null
  country: string | null
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Amazon's AddressInput from the warehouse and the company identity; empty strings where Nexus holds nothing. */
function assemble(warehouse: WarehouseAddress | null, company: { name: string; phone: string; email: string }): Partial<FbaSourceAddress> {
  const address: Partial<FbaSourceAddress> = {
    name: text(company.name),
    companyName: text(company.name) || null,
    addressLine1: text(warehouse?.addressLine1),
    addressLine2: text(warehouse?.addressLine2) || null,
    city: text(warehouse?.city),
    postalCode: text(warehouse?.postalCode),
    countryCode: text(warehouse?.country).toUpperCase(),
    phoneNumber: text(company.phone),
    email: text(company.email) || null,
  }
  return address
}

/** One line to show under the From field ("Xavia · Via …, 47822 Town, IT · +39 …"); null when nothing is known. */
function summaryOf(address: Partial<FbaSourceAddress>): string | null {
  const street = [address.addressLine1, address.addressLine2].filter(Boolean).join(' ')
  const town = [address.postalCode, address.city].filter(Boolean).join(' ')
  const place = [street, town, address.countryCode].filter(Boolean).join(', ')
  const parts = [address.name, place, address.phoneNumber].filter((part) => typeof part === 'string' && part.trim() !== '')
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The ship-from address and its check, for the dialog (reads only; never throws for a missing field).
 * `warehouse` null (no From, or a From with no Warehouse row) → its fields are all missing.
 */
export async function shipFromAddress(warehouse: WarehouseAddress | null): Promise<{ address: Partial<FbaSourceAddress>; check: FbaAddressCheck }> {
  const company = await companyIdentity()
  const address = assemble(warehouse, company)
  return { address, check: { missing: addressMissing(address), summary: summaryOf(address) } }
}

/**
 * The address a plan is created with. Called after `sendProblems` passed (so nothing is missing); the company's name
 * and phone are asked again through `requireCompanyIdentity` so a field emptied meanwhile refuses here
 * (MissingBusinessIdentityError) rather than reaching Amazon blank.
 */
export async function requireShipFromAddress(warehouse: WarehouseAddress | null): Promise<FbaSourceAddress> {
  const company = await requireCompanyIdentity(['name', 'phone'], 'the FBA ship-from address')
  const address = assemble(warehouse, company)
  const missing = addressMissing(address)
  if (missing.length > 0) throw new Error(`The ship-from address needs: ${missing.join(', ')}`)
  const out: FbaSourceAddress = {
    name: address.name!,
    addressLine1: address.addressLine1!,
    city: address.city!,
    postalCode: address.postalCode!,
    countryCode: address.countryCode!,
    phoneNumber: address.phoneNumber!,
  }
  if (address.companyName) out.companyName = address.companyName
  if (address.addressLine2) out.addressLine2 = address.addressLine2
  if (address.email) out.email = address.email
  return out
}
