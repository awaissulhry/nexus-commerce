#!/usr/bin/env node
// Prisma 7's runtime DMMF omits IDs/defaults/FK actions. Generate the small
// metadata surface our tenancy and guarded-delete code needs from validated DMMF.
const { generatorHandler } = require('@prisma/generator-helper')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

generatorHandler({
  onManifest() { return { prettyName: 'Nexus model metadata', defaultOutput: '../workspaces' } },
  onGenerate({ dmmf, generator }) {
    const models = dmmf.datamodel.models.map(model => ({ name: model.name,
      fields: model.fields.filter(field => field.kind === 'object' || (field.isId && typeof field.default === 'string'))
        .map(({ name, kind, type, isId, default: value, relationFromFields, relationOnDelete }) => ({
          name, kind, type, ...(isId ? { isId, default: value } : {}),
          ...(relationFromFields ? { relationFromFields } : {}),
          ...(relationOnDelete ? { relationOnDelete } : {}),
        })),
    }))
    const output = generator.output.value
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'model-metadata.json'), JSON.stringify({ models }, null, 2) + '\n')
  },
})
