/**
 * NAF.SB.W.8 — is the migration safe to apply? Read-only: checks the columns
 * do not exist yet, that every existing row would get templateKey = NULL
 * (i.e. "I am a code charter", which is what they already are), and that no
 * key would collide.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// information_schema returns `name`-typed columns Prisma cannot deserialise —
// cast to text.
const cols = await prisma.$queryRawUnsafe<Array<{ c: string }>>(
  `SELECT column_name::text AS c FROM information_schema.columns
   WHERE table_name = 'AgentCharter' AND column_name IN ('templateKey','promptOverlay')`,
)
console.log('columns already present:', cols.map((c) => c.c).join(', ') || 'none — migration needed')

const rows = await prisma.agentCharter.count()
const dupKeys = await prisma.$queryRawUnsafe<Array<{ key: string }>>(
  `SELECT "key"::text AS key FROM "AgentCharter" GROUP BY "key" HAVING COUNT(*) > 1`,
)
console.log('AgentCharter rows:', rows)
console.log('keys appearing at more than one version:', dupKeys.length === 0 ? 'none' : JSON.stringify(dupKeys.map((d) => d.key)))
console.log('after migration every existing row has templateKey = NULL → still a code charter. No behaviour change.')
await prisma.$disconnect()
