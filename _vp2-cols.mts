import { getSheetColumns } from './apps/api/src/services/pim/sheet-columns.service.js'
import { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.js'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const direct = await getSheetColumns({ market: 'IT', productTypes: ['OUTERWEAR'], familyIds: ['cmtny43jv002jnjfbb6hnijqx'],
  variationAxes: ['Colore','Taglia'], scopeKind: 'channel', channels: ['EBAY'], onlyChannels: ['EBAY'] })
console.log('DIRECT getSheetColumns: columns=', direct.columns.length, 'coords=', JSON.stringify(direct.coordinates))
console.log('  variantEligible=', direct.columns.filter(c => (c as any).variantEligible).map(c => c.key))
console.log('  color col keys=', JSON.stringify(Object.keys(direct.columns.find(c => c.key === 'color') ?? {})))
const sheet = await getStudioSheet({ productId: GALE, scope: 'channel', channel: 'EBAY', market: 'IT', includeMapping: false })
console.log('SHEET: columns=', sheet.columns.length, 'label=', sheet.scope.label)
console.log('  variantEligible=', sheet.columns.filter(c => (c as any).variantEligible).map(c => c.key))
process.exit(0)
