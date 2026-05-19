'use server'

import { prisma } from '@nexus/database'
import { revalidatePath } from 'next/cache'
import { writeSettingsAudit } from '@/lib/settings-audit'

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

  // Phase B — read the existing row BEFORE the write so the audit
  // diff has a real before/after pair.
  const existing = await (prisma as any).accountSettings.findFirst()

  if (existing) {
    await (prisma as any).accountSettings.update({
      where: { id: existing.id },
      data,
    })
    await writeSettingsAudit({
      key: 'account',
      action: 'update',
      before: snapshot(existing),
      after: data,
    })
  } else {
    await (prisma as any).accountSettings.create({ data })
    await writeSettingsAudit({
      key: 'account',
      action: 'create',
      before: null,
      after: data,
    })
  }

  revalidatePath('/settings/account')
  return { success: true }
}
