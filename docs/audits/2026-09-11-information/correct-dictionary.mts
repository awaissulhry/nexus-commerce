/** Preview by default. Only --apply=<reviewed fingerprint> writes definitions; no Product writes. */
import prisma from '../../../apps/api/src/db.js'
import { dictionaryCorrectionPreview, applyDictionaryCorrection } from '../../../apps/api/src/services/pim/information-dictionary-correction.js'
const families = process.argv.filter(arg => arg.startsWith('--family=')).map(arg => arg.slice(9))
const fingerprint = process.argv.find(arg => arg.startsWith('--apply='))?.slice(8)
if (process.argv.includes('--local-development')) {
  const target = new URL(process.env.DATABASE_URL ?? '')
  if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/nexus_development') throw new Error('This invocation is restricted to the isolated local development database.')
}
console.log(JSON.stringify(fingerprint ? await applyDictionaryCorrection(prisma as any, families, fingerprint) : await dictionaryCorrectionPreview(prisma as any, families), null, 2))
await prisma.$disconnect()
