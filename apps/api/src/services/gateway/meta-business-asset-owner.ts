/**
 * Meta step 43 (2026-10-26) — the gateway's own check of a create-meta-backed-account or set-meta-billing change (gateway.ts
 * hands every write a step-43 rule judged here, by the rule, never by the kind alone). Nothing is sent to Meta unless every
 * part of it holds, with the gateway's OWN reads (a caller that skipped the tools still sends nothing they would refuse).
 * Reads only, through the gateway; a read that is refused, not a success, or cut (more pages than Nexus reads) refuses the
 * change (step 41's listedRows).
 *
 *   the object (its kind)
 *     backedpage       the business's CHOSEN Facebook Page (its PAGE link through this connection)
 *     backedinstagram  the business's CHOSEN Instagram account (its INSTAGRAM link through this connection)
 *     creditline       a credit line the chosen ad account's business portfolio OWNS (extendedcredits owner_business), on a
 *                      portfolio no other business in Nexus uses (step 41's sharedPortfolio: its link, or one of its own ad
 *                      accounts, Pages or Instagram accounts another business chose; unknown counts as shared)
 *     invoicegroup     an invoice group of such a credit line, which bills no ad account another business in Nexus uses
 *                      (its ad accounts read in full); the ad account moved in or out is THE chosen one (act_<id>); a delete
 *                      only of a group that bills no ad account at all
 * Checked 2026-10-26: business/extendedcredits (owner_business), extended-credit/extended_credit_invoice_groups,
 * extended-credit-invoice-group/ad_accounts (Meta's SDK get_ad_accounts: account_id) — the same reads as meta-billing.
 */
import type { MetaJudgedWrite } from './meta-calls.js'
import { chosenBusiness, type MetaOwnerIo, type MetaOwnerProblem } from './meta-optimize-owner.js'
import { listedIdSet, listedRows, sharedPortfolio } from './meta-access-owner.js'
import { metaChosenInstagramOf, metaChosenPageOf } from './account.js'
import { takenIds } from '../marketing/meta-ads/taken.js'
import type { MetaBusinessAssetKind } from './meta-business-asset-rules.js'

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const UNCONFIRMED = 'META_ACCOUNT_UNCONFIRMED'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
const say = (code: string, sentence: string): MetaOwnerProblem => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).id : v
  return (typeof raw === 'string' || typeof raw === 'number') && /^\d{1,25}$/.test(String(raw)) ? String(raw) : null
}
/** An ad account id as Meta lists it (account_id digits, or act_<digits>), as digits. */
const accountDigits = (v: unknown): string | null => {
  const raw = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/^act_/, '') : ''
  return /^\d{1,25}$/.test(raw) ? raw : null
}

/** Why a step-43 change of this object is refused for this connection, or null. */
export async function metaBusinessAssetOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined, io: MetaOwnerIo): Promise<MetaOwnerProblem | null> {
  if (write.check) return say(NOT_ALLOWED, 'Meta documents no check (validate_only) for this change.')
  if (!kind || !(write.kinds as readonly string[] | undefined)?.includes(kind)) return say(NOT_ALLOWED, `this change is not one of a ${kind ?? 'named kind of object'}.`)
  const id = write.objectId
  const asset = kind as MetaBusinessAssetKind
  if (asset === 'backedpage') {
    const page = await metaChosenPageOf(connectionId)
    if (!page) return say(NOT_CHOSEN, 'this business has chosen no Facebook Page through this connection.')
    return id === page ? null : say(NOT_CHOSEN, `${id} is not the Facebook Page this business chose.`)
  }
  if (asset === 'backedinstagram') {
    const instagram = await metaChosenInstagramOf(connectionId)
    if (!instagram) return say(NOT_CHOSEN, 'this business has chosen no Instagram account through this connection.')
    return id === instagram ? null : say(NOT_CHOSEN, `${id} is not the Instagram account this business chose.`)
  }
  // ── billing: a credit line or invoice group of the chosen ad account's OWN, unshared portfolio ──
  const chosen = await io.chosenAdAccount()
  if (!chosen) return say(NOT_CHOSEN, 'this business has no Meta ad account chosen through this connection, so Nexus changes no billing on Meta.')
  const portfolio = await chosenBusiness(io, chosen)
  if (!portfolio) return say(UNCONFIRMED, 'Nexus could not read the business portfolio of the chosen ad account (credit lines belong to a portfolio).')
  const shared = await sharedPortfolio(io, portfolio, chosen)
  if (shared !== false) return say(NOT_CHOSEN, shared ? 'another business in Nexus uses this Meta business portfolio: its credit line bills that business\'s ads too.' : 'Nexus could not read the business portfolio\'s own ad accounts, Pages and Instagram accounts in full, so it cannot tell that no other business in Nexus uses it.')
  const lines = await listedRows(io, `${portfolio}/extendedcredits`, { fields: 'id,owner_business{id}' })
  if (!lines) return say(UNCONFIRMED, 'Nexus could not read the business portfolio\'s credit lines.')
  const owned = lines.filter((r) => idOf(r.owner_business) === portfolio).map((r) => idOf(r)).filter((x): x is string => !!x)
  if (asset === 'creditline') return owned.includes(id) ? null : say(NOT_CHOSEN, `${id} is not a credit line the chosen ad account's business portfolio owns.`)
  let found = false
  for (const line of owned) {
    const groups = await listedIdSet(io, `${line}/extended_credit_invoice_groups`)
    if (!groups) return say(UNCONFIRMED, `Nexus could not read credit line ${line}'s invoice groups in full.`)
    if (groups.has(id)) { found = true; break }
  }
  if (!found) return say(NOT_CHOSEN, `${id} is not an invoice group of a credit line the chosen ad account's business portfolio owns.`)
  const rows = await listedRows(io, `${id}/ad_accounts`, { fields: 'account_id' })
  if (!rows) return say(UNCONFIRMED, `Nexus could not read every ad account invoice group ${id} bills.`)
  const accounts = rows.map((r) => accountDigits(r.account_id ?? r.id)).filter((x): x is string => !!x)
  if ((await takenIds('AD_ACCOUNT', accounts.filter((a) => a !== chosen))).size) return say(NOT_CHOSEN, `invoice group ${id} bills an ad account another business in Nexus uses: it is that business's billing too.`)
  if (write.rule === 'billing.invoiceGroup.addAccount' || write.rule === 'billing.invoiceGroup.removeAccount') {
    const named = new URLSearchParams(write.body ?? '').get('ad_account_id')
    if (named !== `act_${chosen}`) return say(NOT_CHOSEN, 'only the ad account this business chose through this connection is put in or taken out of an invoice group.')
  }
  if (write.rule === 'billing.invoiceGroup.delete' && accounts.length) return say(NOT_ALLOWED, `invoice group ${id} still bills ${accounts.length} ad account${accounts.length === 1 ? '' : 's'}: Nexus deletes only an empty invoice group.`)
  return null
}
