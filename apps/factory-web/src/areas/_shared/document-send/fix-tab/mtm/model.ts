import { MTM_LINE_CODES } from '@nexus/factory-domain/sales/mtm/codes'
import type { Translate } from '../../../../../lib/i18n/messages'
import type { SendCheckItem } from '../../model'

/**
 * The send dialog's fix tab for the made-to-measure line checks (B-W2b-368, XF1:04; B-W2b-358's MTM_* send-check codes fell to no
 * tab): each MTM_* check says in words what holds the unit — its line, its rider, the revision it is made to — and its fix opens
 * the rider profile (Sales › Made-to-measure › the profile: the factory review, the newer revision, the off state and where it is
 * started). The units are the document's own (GET /sales/quotes/:id/made-to-measure: line → rider profile); without them (not
 * read, or the person may not see measurements) the check keeps its words and no fix link. Pure; words of the
 * `sales-mtm-followups` catalogue through `t` (that catalogue's translator).
 */

export const MTM_FIX_NAMESPACE = 'sales-mtm-followups'
export type MtmCode = (typeof MTM_LINE_CODES)[number]

export const isMtmCode = (code: string): code is MtmCode => (MTM_LINE_CODES as readonly string[]).includes(code)

/** A unit of the document as the fix reads it (factory-domain documentUnitsView). */
export interface FixUnit {
  readonly lineId: string
  readonly seq: number
  readonly profile: { readonly id: string; readonly riderName: string; readonly garmentType: string; readonly revision: number; readonly latestRevision: number }
}

/** The check as the API answers it. */
export interface FixCheck {
  readonly code: string
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly lineId: string | null
}

/** The rider profile's address for a unit (the record's measurements tab). */
export const profileHref = (prefix: string, profileId: string): string => `${prefix}/sales/made-to-measure/${encodeURIComponent(profileId)}`

/**
 * One MTM_* check as the dialog lists it: in words of its unit (line, rider, garment and revision; the newest for MTM_NOT_LATEST),
 * the fix "Open the rider profile" when the unit is known and the person may open it.
 */
export function mtmFixItem(check: FixCheck, index: number, units: readonly FixUnit[] | null, t: Translate, prefix: string, mayOpen: boolean): SendCheckItem {
  const code = check.code as MtmCode
  const unit = check.lineId ? (units?.find((entry) => entry.lineId === check.lineId) ?? null) : null
  const label = unit
    ? t(`fix.${code}`, { seq: unit.seq, rider: unit.profile.riderName, garment: unit.profile.garmentType, revision: unit.profile.revision, latest: unit.profile.latestRevision })
    : t(`fix.general.${code}`)
  return {
    id: `${check.code}-${index}`,
    state: check.severity === 'BLOCKS' ? 'blocks' : 'warning',
    label,
    fix: unit && mayOpen ? { label: t('fix.open'), href: profileHref(prefix, unit.profile.id) } : null,
  }
}
