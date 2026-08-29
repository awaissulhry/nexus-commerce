/**
 * CX.1 — importing this module registers every catalogue entry.
 * eBay is the only connectable channel in CX.1; the others are declared so
 * the UI can render honest "not yet available" cards and CX.3/5/6 have their
 * auth shapes fixed.
 */
import './ebay/spec.js'
import './amazon-sp/spec.js'
import './amazon-ads/spec.js'
import './shopify/spec.js'
import './etsy/spec.js'
