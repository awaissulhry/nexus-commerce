/**
 * Phase 8 PRE-FLIGHT — read-only readiness check for the AIREON family.
 *
 * Zero eBay writes. Confirms the family will push clean BEFORE the operator
 * triggers the live publish: resolved axes (no ghosts, theme set), and per
 * variant-row completeness of the fields the push consumes (price, qty,
 * aspect values for each theme axis, ≥1 image), plus parent-level title /
 * category / business policies.
 *
 * Usage: tsx apps/api/scripts/_p8-preflight.mts
 */
import prisma from '../src/db.js'
import { resolveFamilyAxes } from '../src/services/ebay-family-axes.service.js'
import { buildEbayFamilyRows } from '../src/services/ebay-variation-push.service.js'

const PARENT_ID = 'cmr1b1yxl0000s4rcvopsqv42'
const MARKET = 'IT'

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v))

async function main() {
  const axesRes = await resolveFamilyAxes(PARENT_ID, MARKET)
  const themeAxisKeys = axesRes.axes.map((a) => a.key)

  const rows = await buildEbayFamilyRows(PARENT_ID)
  const parentRow = rows.find((r) => r._isParent === true) ?? rows[0]
  const variantRows = rows.filter((r) => r._isParent !== true)

  // Per-variant completeness.
  const problems: string[] = []
  const perVariant = variantRows.map((r) => {
    const sku = str(r.sku) || str(r._sku) || '(no sku)'
    const price = num(r[`${MARKET}_price`] ?? r.price)
    const qty = num(r[`${MARKET}_qty`] ?? r.quantity)
    const images = [1, 2, 3, 4, 5, 6].filter((i) => str(r[`image_${i}`])).length
    // aspect_ value for each theme axis
    const missingAspects = axesRes.axes.filter((a) => {
      // find the aspect_ key on the row whose name matches this axis
      const direct = str(r[`aspect_${a.name}`])
      const byKey = Object.entries(r).find(
        ([k, v]) => k.startsWith('aspect_') && str(v) && k.slice(7).toLowerCase().replace(/_/g, ' ') === a.name.toLowerCase(),
      )
      return !direct && !byKey
    }).map((a) => a.name)

    const rowProblems: string[] = []
    if (!(price > 0)) rowProblems.push('price')
    if (!(qty >= 0)) rowProblems.push('qty')
    if (images === 0) rowProblems.push('no-image')
    if (missingAspects.length) rowProblems.push(`aspect:${missingAspects.join('|')}`)
    if (rowProblems.length) problems.push(`${sku}: ${rowProblems.join(', ')}`)
    return { sku, price, qty, images, missingAspects }
  })

  // Parent-level.
  const parentTitle = str(parentRow?.title)
  const category = str(parentRow?.category ?? parentRow?.categoryId ?? parentRow?.ebay_category)
  const fulfillment = str(parentRow?.fulfillment_policy_id)
  const payment = str(parentRow?.payment_policy_id)
  const ret = str(parentRow?.return_policy_id)

  const parentProblems: string[] = []
  if (!parentTitle) parentProblems.push('parent title empty')
  if (!fulfillment) parentProblems.push('fulfillment_policy_id empty')
  if (!payment) parentProblems.push('payment_policy_id empty')
  if (!ret) parentProblems.push('return_policy_id empty')

  const go = problems.length === 0 && parentProblems.length === 0 && axesRes.axes.length >= 2

  console.log(JSON.stringify({
    verdict: go ? 'GO' : 'REVIEW',
    axes: {
      theme: themeAxisKeys,
      axisCount: axesRes.axes.length,
      values: axesRes.axes.map((a) => ({ name: a.name, n: a.values.length, values: a.values })),
      warnings: axesRes.warnings,
      suppressedGhosts: axesRes.suppressed,
    },
    variants: { count: variantRows.length, sample: perVariant.slice(0, 3), problems },
    parent: { title: parentTitle, category, policies: { fulfillment, payment, ret }, problems: parentProblems },
  }, null, 2))

  await prisma.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
