import '../src/env.js'
const { gradeFindings } = await import('../src/services/agent-fleet/shadow-grade.service.js')
const r = await gradeFindings(['cmshhcfwk00agt7018xc76538', 'cmshk7c0q000opc01b38rczgz', 'cmshk7c03000npc01946b3ul7'])
console.log('GRADED:', JSON.stringify(r))
const { default: prisma } = await import('../src/db.js')
await prisma.$disconnect()
