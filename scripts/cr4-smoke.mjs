// CR.4 smoke: validate the print-label branch logic + rate-shop input
// shape. Doesn't hit the live API; just confirms the new code paths
// load and the Buy Shipping mock returns the expected shape with
// real (non-empty) inputs.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })

const buyShipping = await import('/Users/awais/nexus-commerce/apps/api/src/services/amazon-pushback/buy-shipping.ts')

// ── (1) getEligibleShippingServices with REAL inputs (CR.4 fix) ──
const eligibility = await buyShipping.getEligibleShippingServices({
  amazonOrderId: '111-1234567-7654321',          // real Amazon order id shape
  itemList: [{ orderItemId: '12345678901234', quantity: 1 }], // real OrderItemId shape
  shipFromAddress: {
    name: 'Xavia Riccione',
    addressLine1: 'Via dei Cavalieri 12',
    city: 'Riccione',
    postalCode: '47838',
    countryCode: 'IT',
  },
  weightGrams: 1500,
})
console.log('eligibility services:', eligibility.length)
console.log('  cheapest:', eligibility.reduce((a, b) => a.rate.amount <= b.rate.amount ? a : b).carrierName, '-', eligibility.reduce((a, b) => a.rate.amount <= b.rate.amount ? a : b).rate.amount, 'EUR')

// ── (2) createShipment dryRun returns a valid label ──
const purchased = await buyShipping.createShipment({
  amazonOrderId: '111-1234567-7654321',
  itemList: [{ orderItemId: '12345678901234', quantity: 1 }],
  shipFromAddress: {
    name: 'Xavia Riccione',
    addressLine1: 'Via dei Cavalieri 12',
    city: 'Riccione',
    postalCode: '47838',
    countryCode: 'IT',
  },
  weightGrams: 1500,
}, eligibility[0].shippingServiceOfferId)
console.log('purchased:')
console.log('  trackingId:', purchased.trackingId)
console.log('  rate:', purchased.rate.amount, purchased.rate.currencyCode)
console.log('  labelData length:', purchased.labelData?.length || 0, 'chars (base64)')
console.log('  dryRun:', purchased.dryRun)

// ── (3) Verify routes file has the three branches ──
const routes = (await import('node:fs/promises')).readFileSync
  ? null
  : null
const fs = await import('node:fs/promises')
const src = await fs.readFile('/Users/awais/nexus-commerce/apps/api/src/routes/fulfillment.routes.ts', 'utf8')
const branches = {
  manual: /carrierCode === 'MANUAL'/.test(src),
  buyShipping: /carrierCode === 'AMAZON_BUY_SHIPPING'/.test(src),
  sendcloudFallthrough: /SENDCLOUD \(default\)/.test(src),
}
console.log('\nprint-label branches:', branches)
console.log('\nCR.4 smoke complete')
