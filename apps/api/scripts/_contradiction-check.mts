import { pipelineHealth } from '../src/services/advertising/ads-pipeline-health.service.js'
const h = await pipelineHealth()
const L: string[] = [`CONTRADICTIONS=${h.contradictions.length} elapsed=${h.elapsedMs}ms`]
for (const c of h.contradictions) L.push(`CX| [${c.severity}] ${c.marketplace} ${c.date} (${c.kind}) :: ${c.detail}`)
console.error(L.join('\n'))
process.exit(0)
