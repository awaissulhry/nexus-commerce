import '../src/env.js'
import prisma from '../src/db.js'
import { getKeywordTracker } from '../src/services/advertising/keyword-tracker.service.js'
const d: any = await getKeywordTracker({ market: 'IT' } as any)
console.log('TOP-LEVEL KEYS:', Object.keys(d).join(', '))
console.log('WINDOW:', JSON.stringify(d.window).slice(0, 600))
const rowsKey = ['rows', 'terms', 'items', 'data'].find((k) => Array.isArray(d[k]))
console.log('ROWS KEY:', rowsKey, '· length', rowsKey ? d[rowsKey].length : 0)
if (rowsKey && d[rowsKey][0]) console.log('ROW[0]:', JSON.stringify(d[rowsKey][0]).slice(0, 700))
await prisma.$disconnect()
