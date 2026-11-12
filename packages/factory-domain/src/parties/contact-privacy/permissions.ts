import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Personal-data controls on a party's contacts (B-W2b-290; SAL-022; GDPR arts. 6, 7, 15, 17, 21), checked with can() over
 * the party (its company AND itself; a tenant-wide party: a grant over every company). Reading the contacts' basis and
 * consent is parties.view (the contacts are personal data already behind it).
 *
 *   privacy   record a contact's lawful basis and consent, record an objection or a withdrawn consent, and give the person
 *             an access copy of what we hold (art. 15; the copy is recorded in the audit)
 *   erase     erase a contact on request (art. 17): their name, e-mail and phone blanked for good, the row kept for the
 *             documents that name it. Cannot be undone, so it asks a fresh code (risk stepUp)
 */
export const PARTIES_PRIVACY_DEFINITIONS = definePermissions('parties', {
  privacy: {
    risk: 'write',
    description: "Record a contact's lawful basis and consent, an objection or a withdrawn consent, and give the person an access copy of what we hold about them.",
  },
  erase: {
    risk: 'stepUp',
    description: "Erase a contact on request: their name, e-mail and phone are blanked for good and the row stays for the documents that name it. Asks a fresh code; it cannot be undone.",
  },
})

export const PARTIES_PRIVACY = 'parties.privacy' satisfies Permission
export const PARTIES_ERASE = 'parties.erase' satisfies Permission
export const PARTIES_PRIVACY_PERMISSIONS: readonly Permission[] = Object.freeze([PARTIES_PRIVACY, PARTIES_ERASE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the office people who keep contacts (parties.manage:
 * finance, sales, buyer) record the basis and give access copies; erasure, which cannot be undone, is finance's.
 */
export const PARTIES_PRIVACY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [PARTIES_PRIVACY, PARTIES_ERASE],
  sales: [PARTIES_PRIVACY],
  buyer: [PARTIES_PRIVACY],
})
