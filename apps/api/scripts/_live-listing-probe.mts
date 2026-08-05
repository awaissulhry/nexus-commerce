/** READ-ONLY: field inventory of a live Trading listing — the ground truth
 *  for what AddFixedPriceItem must send on this account/category. */
process.env.NEXUS_EBAY_REAL_API = 'true'
const { default: prisma } = await import('../src/db.js')
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')

const ITEM = process.argv[2] ?? '256564203510' // IT-GALE — a live Trading ALT listing
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${ITEM}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
  { oauthToken: token, siteId: siteIdForMarket('IT') })
const raw = got.raw
const pick = (tag: string) => raw.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '(absent)'
console.log('Location:', pick('Location'))
console.log('PostalCode:', pick('PostalCode'))
console.log('Country:', pick('Country'))
console.log('DispatchTimeMax:', pick('DispatchTimeMax'))
console.log('ConditionID:', pick('ConditionID'))
const specBlock = /<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/.exec(raw)?.[1] ?? ''
const specs = [...specBlock.matchAll(/<NameValueList><Name>([^<]*)<\/Name>(?:<Value>([^<]*)<\/Value>)+<\/NameValueList>/g)]
  .map((m) => `${m[1]} = ${m[2]}`)
console.log('ItemSpecifics (' + specs.length + '):')
for (const s of specs) console.log('  ' + s)
const set = /<VariationSpecificsSet>([\s\S]*?)<\/VariationSpecificsSet>/.exec(raw)?.[1] ?? ''
console.log('DECLARED AXES:', JSON.stringify([...set.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])))
const specNames = [...(/<ItemSpecifics>([\s\S]*?)<\/ItemSpecifics>/.exec(raw)?.[1] ?? '').matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1])
console.log('ITEM SPECIFIC NAMES:', JSON.stringify(specNames))
const profiles = [...raw.matchAll(/<(ShippingProfileID|PaymentProfileID|ReturnProfileID)>([^<]*)<\/\1>/g)].map((m) => `${m[1]}=${m[2]}`)
console.log('SellerProfiles:', profiles.join(' ') || '(absent)')
await prisma.$disconnect()
