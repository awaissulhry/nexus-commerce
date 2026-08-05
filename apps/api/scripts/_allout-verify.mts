import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const t = await p.rankTarget.findMany({ select:{key:true,allOut:true,acosCapPct:true,maxCpcCents:true} })
console.log('rank targets — ceilings after the change:')
for (const x of t) console.log(`  ${x.key.padEnd(18)} allOut=${String(x.allOut).padEnd(5)} acosCap=${String(x.acosCapPct ?? '—').padStart(4)}  maxCpc=${x.maxCpcCents!=null?`€${(x.maxCpcCents/100).toFixed(2)}`:'NONE'}`)
const unbounded = t.filter(x=>x.allOut && x.maxCpcCents==null)
console.log(unbounded.length===0 ? '\nNo all-out target is unbounded any more.' : `\nSTILL UNBOUNDED: ${unbounded.map(x=>x.key).join(', ')}`)
await p.$disconnect()
