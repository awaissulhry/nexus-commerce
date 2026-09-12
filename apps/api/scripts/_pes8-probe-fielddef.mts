import '../src/env.js'
const { getFieldDefinition } = await import('../src/services/pim/field-registry.service.js')
const { default: prisma } = await import('../src/db.js')
for (const f of ['attr_material', 'attr_color', 'attr_fabric_type', 'attr_style']) {
  for (const mkt of [null, 'IT']) {
    const def = await getFieldDefinition(f, { marketplace: mkt })
    console.log(`${f.padEnd(20)} market=${String(mkt).padEnd(5)} -> ${def ? `found editable=${def.editable} type=${def.type}` : 'NOT FOUND'}`)
  }
}
await prisma.$disconnect()
