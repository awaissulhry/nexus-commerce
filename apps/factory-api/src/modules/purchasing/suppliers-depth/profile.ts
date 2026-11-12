import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { changeProfile, PROFILE_FIELDS, type ProfileField, type ProfilePatch } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayWrite, assertWritable, contextOf } from '../../parties/store'
import { profileOf, readSupplier, readSupplierRow } from './store'
import { supplierView } from './view'

/**
 * A supplier's profile (B-W2b-311; SCM-002 kinds, SCM-016 origin, the W1 default lead time; design purchasing.suppliers ›
 * Overview "Roles", "Origin"): parties.view to read, parties.manage over the supplier's company and itself to change
 * (the supplier record is its party record). One command on the Party: its version is the edit guard. The kinds need a
 * supplier role; the raw hides' origin and the tannages need TANNERY in the kinds after the change (remove TANNERY and
 * clear them in one change). Audited; party.updated with the fields that changed.
 */

export interface ProfileBody extends ProfilePatch {
  readonly version: number
}

const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

/** parties.view: the supplier's depth (see view.ts). */
export async function getProfile(caller: CommandCaller, partyId: string) {
  const row = await readSupplier(caller, partyId)
  return { supplier: await caller.withClient((client) => supplierView(client, row, serverClock.now())) }
}

/** parties.manage: the kinds, default lead time and origin the body gives. */
export async function updateProfile(caller: CommandCaller, partyId: string, body: ProfileBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const seen = await readSupplier(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, seen)
  assertWritable(seen.status)
  const { version, ...patch } = body
  const preview = changeProfile(profileOf(seen), patch, seen.roles)
  if (!preview.ok) throw new ValidationError('The supplier profile is not valid.', prefixed(preview.issues))

  const { result } = await command(
    caller,
    { name: 'purchasing.suppliers.profile', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const row = (await readSupplierRow(tx, partyId))!
      assertWritable(row.status)
      const change = changeProfile(profileOf(row), patch, row.roles)
      if (!change.ok) throw new ValidationError('The supplier profile is not valid.', prefixed(change.issues))
      if (change.changed.length > 0) {
        const pick = (profile: typeof change.profile, fields: readonly ProfileField[]) => Object.fromEntries(fields.map((field) => [field, profile[field]]))
        const next = change.profile
        await tx.party.update({
          where: { id: partyId },
          data: {
            supplierKinds: [...next.kinds],
            leadTimeDays: next.leadTimeDays,
            originCountry: next.originCountry,
            originRegion: next.originRegion,
            originNote: next.originNote,
            hideOriginCountries: [...next.hideOriginCountries],
            tannages: [...next.tannages],
          },
          select: { id: true },
        })
        const fields = PROFILE_FIELDS.filter((field) => change.changed.includes(field))
        tools.audit({ recordType: 'Party', recordId: partyId, companyId: row.companyId, before: pick(profileOf(row), fields), after: pick(next, fields) })
        tools.emit({ type: 'party.updated', subject: partyId, companyId: row.companyId, payload: { partyId, code: row.code, fields: fields.map((field) => (field === 'kinds' ? 'supplierKinds' : field)) } })
      }
      return { supplier: await supplierView(tx, (await readSupplierRow(tx, partyId))!, tools.now) }
    },
  )
  return result
}
