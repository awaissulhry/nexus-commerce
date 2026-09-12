'use server'
import { currentWebUser, requireWebPermission } from '@/lib/workspaces/server'

import { prisma } from '@nexus/database'
import { Prisma } from '@prisma/client'
import { BUSINESS_COUNTRIES } from '@nexus/shared/business-profile'
import { revalidatePath } from 'next/cache'

/**
 * Snapshot fields we want represented in the audit diff. Anything
 * here that changes will appear in the /settings/audit viewer.
 */
const SNAPSHOT_FIELDS = [
  'businessName',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'postalCode',
  'country',
  'timezone',
  'currency',
  'primaryMarketplace',
] as const

function snapshot(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const k of SNAPSHOT_FIELDS) out[k] = row[k] ?? null
  return out
}

export async function saveAccountSettings(formData: FormData) {
  await requireWebPermission('settings.workspace.edit')
  // PSM.1 — primaryMarketplace: nullable. Empty string from the form
  // collapses to null so the matcher consumers (Step 1 default-select)
  // see a proper absent signal rather than a blank string.
  const rawPrimary = (formData.get('primaryMarketplace') as string) ?? ''
  const data = {
    businessName: formData.get('businessName') as string || '',
    addressLine1: formData.get('addressLine1') as string || '',
    addressLine2: formData.get('addressLine2') as string || '',
    city: formData.get('city') as string || '',
    state: formData.get('state') as string || '',
    postalCode: formData.get('postalCode') as string || '',
    country: formData.get('country') as string || 'US',
    timezone: formData.get('timezone') as string || 'America/New_York',
    currency: formData.get('currency') as string || 'USD',
    primaryMarketplace: rawPrimary.trim().toUpperCase() || null,
  }

  data.businessName = data.businessName.trim()
  if (data.businessName.length < 2 || data.businessName.length > 80) throw new Error('Business name must contain 2–80 characters.')
  if (!BUSINESS_COUNTRIES.includes(data.country)) throw new Error('Choose a valid business country.')
  if (!(Intl as typeof Intl & { supportedValuesOf(key: 'currency'): string[] }).supportedValuesOf('currency').includes(data.currency)) throw new Error('Choose a valid reporting currency.')
  try { new Intl.DateTimeFormat('en', { timeZone: data.timezone }).format() } catch { throw new Error('Choose a valid business timezone.') }
  if (data.primaryMarketplace && !BUSINESS_COUNTRIES.includes(data.primaryMarketplace)) throw new Error('Primary marketplace must be a valid country code.')
  for (const value of [data.addressLine1, data.addressLine2, data.city, data.state, data.postalCode]) if (value.length > 200) throw new Error('Address fields must be 200 characters or fewer.')
  const expected = String(formData.get('updatedAt') ?? '')
  const actorId = process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1' ? (await currentWebUser()).id : null

  // Phase B — read the existing row BEFORE the write so the audit
  // diff has a real before/after pair.
  const next = await prisma.$transaction(async tx => {
    const existing = await tx.accountSettings.findFirst()
    if (existing) {
      if (!expected || expected !== existing.updatedAt.toISOString()) throw new Error('These settings changed in another tab. Reload before saving your changes.')
      const result = await tx.accountSettings.updateMany({ where: { id: existing.id, updatedAt: existing.updatedAt }, data: { ...data, updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)) } })
      if (result.count !== 1) throw new Error('These settings changed in another tab. Reload before saving your changes.')
    } else {
      if (actorId) throw new Error('Business settings are unavailable. Reload before saving.')
      await tx.accountSettings.create({ data })
    }
    await tx.auditLog.create({ data: { userId: actorId, entityType: 'Settings', entityId: 'account', action: existing ? 'update' : 'create', before: snapshot(existing) as Prisma.InputJsonValue ?? Prisma.JsonNull, after: data, metadata: { source: 'settings-ui', label: 'Business' } } })
    return tx.accountSettings.findFirstOrThrow()
  })

  revalidatePath('/settings/account')
  return { success: true, updatedAt: next.updatedAt.toISOString() }
}
