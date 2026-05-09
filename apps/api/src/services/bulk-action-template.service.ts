/**
 * W5.1 — BulkActionTemplate service.
 *
 * CRUD + parameter substitution for reusable bulk-action templates.
 * Distinct from BulkOpsTemplate (grid VIEWS); see schema comment on
 * the model for the design rationale.
 *
 * Pure data layer — no Prisma transactions across services. The
 * apply path (W5.3) calls this service to materialise an actionPayload
 * with parameters substituted, then hands the result to
 * BulkActionService.createJob unchanged.
 */

import type { PrismaClient, BulkActionTemplate } from '@prisma/client'
import prisma from '../db.js'
import {
  isKnownBulkActionType,
  type BulkActionType,
} from './bulk-action.service.js'

export interface ParameterDecl {
  /** Stable name used in placeholders. Must match `${name}` literals
   *  inside actionPayload. ASCII letters / digits / _. */
  name: string
  /** Human-readable label rendered above the input in the apply UI. */
  label: string
  /** Input type. 'select' carries an options array. */
  type: 'string' | 'number' | 'select' | 'boolean'
  /** Default value the apply UI seeds the input with. */
  defaultValue?: unknown
  /** True forces the operator to fill the input before applying. */
  required?: boolean
  /** Optional UI hint rendered below the input. */
  helpText?: string
  /** Numeric bounds — apply UI uses these for min/max attrs and the
   *  service validates again before substitution. */
  min?: number
  max?: number
  /** select options. Required when type === 'select'. */
  options?: string[]
}

export interface CreateTemplateInput {
  name: string
  description?: string | null
  actionType: BulkActionType
  channel?: string | null
  actionPayload?: Record<string, unknown>
  defaultFilters?: Record<string, unknown> | null
  parameters?: ParameterDecl[]
  category?: string | null
  userId?: string | null
  isBuiltin?: boolean
  createdBy?: string | null
}

export interface ApplyTemplateResult {
  /** Final actionPayload ready to hand to BulkActionService.createJob. */
  actionPayload: Record<string, unknown>
  /** Final filters (template defaults + caller overrides). */
  filters: Record<string, unknown> | null
}

export class BulkActionTemplateService {
  constructor(private prisma: PrismaClient = prisma) {}

  /**
   * List templates, optionally filtered by user / category /
   * actionType. Most-used first by default — the library surface
   * wants operator's go-to templates at the top.
   */
  async listTemplates(filters: {
    userId?: string | null
    category?: string
    actionType?: string
    includeBuiltins?: boolean
    limit?: number
  } = {}): Promise<BulkActionTemplate[]> {
    const where: any = {}
    // Filter on userId — null OR the operator's id, plus builtins
    // when requested. Empty filter returns everything.
    if (filters.userId !== undefined) {
      const ors: any[] = []
      if (filters.userId === null) ors.push({ userId: null })
      else ors.push({ userId: filters.userId }, { userId: null })
      if (filters.includeBuiltins !== false) {
        ors.push({ isBuiltin: true })
      }
      where.OR = ors
    }
    if (filters.category) where.category = filters.category
    if (filters.actionType) where.actionType = filters.actionType
    return this.prisma.bulkActionTemplate.findMany({
      where,
      orderBy: [
        { usageCount: 'desc' },
        { updatedAt: 'desc' },
      ],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  async getTemplate(id: string): Promise<BulkActionTemplate | null> {
    return this.prisma.bulkActionTemplate.findUnique({ where: { id } })
  }

  async createTemplate(
    input: CreateTemplateInput,
  ): Promise<BulkActionTemplate> {
    if (!input.name || !input.name.trim()) {
      throw new Error('name is required')
    }
    if (!isKnownBulkActionType(input.actionType)) {
      throw new Error(
        `actionType '${input.actionType}' is not in KNOWN_BULK_ACTION_TYPES`,
      )
    }
    return this.prisma.bulkActionTemplate.create({
      data: {
        name: input.name.trim(),
        description: input.description ?? null,
        actionType: input.actionType,
        channel: input.channel ?? null,
        actionPayload: (input.actionPayload ?? {}) as any,
        defaultFilters: (input.defaultFilters ?? null) as any,
        parameters: (input.parameters ?? []) as any,
        category: input.category ?? null,
        userId: input.userId ?? null,
        isBuiltin: input.isBuiltin ?? false,
        createdBy: input.createdBy ?? null,
      },
    })
  }

  async updateTemplate(
    id: string,
    patch: Partial<CreateTemplateInput>,
  ): Promise<BulkActionTemplate> {
    const existing = await this.prisma.bulkActionTemplate.findUnique({
      where: { id },
    })
    if (!existing) throw new Error(`Template not found: ${id}`)
    if (existing.isBuiltin) {
      throw new Error(
        'Cannot update a built-in template directly — duplicate it first',
      )
    }
    if (
      patch.actionType !== undefined &&
      !isKnownBulkActionType(patch.actionType)
    ) {
      throw new Error(
        `actionType '${patch.actionType}' is not in KNOWN_BULK_ACTION_TYPES`,
      )
    }
    const data: any = {}
    if (patch.name !== undefined) data.name = patch.name.trim()
    if (patch.description !== undefined) data.description = patch.description
    if (patch.actionType !== undefined) data.actionType = patch.actionType
    if (patch.channel !== undefined) data.channel = patch.channel
    if (patch.actionPayload !== undefined)
      data.actionPayload = patch.actionPayload
    if (patch.defaultFilters !== undefined)
      data.defaultFilters = patch.defaultFilters
    if (patch.parameters !== undefined) data.parameters = patch.parameters
    if (patch.category !== undefined) data.category = patch.category
    return this.prisma.bulkActionTemplate.update({ where: { id }, data })
  }

  async deleteTemplate(id: string): Promise<void> {
    const existing = await this.prisma.bulkActionTemplate.findUnique({
      where: { id },
    })
    if (!existing) return
    if (existing.isBuiltin) {
      throw new Error(
        'Cannot delete a built-in template — disable instead by duplicating',
      )
    }
    await this.prisma.bulkActionTemplate.delete({ where: { id } })
  }

  /**
   * Duplicate a template (typically a built-in) into a user-owned
   * editable copy. The new row carries `isBuiltin=false` so the
   * operator can edit it freely.
   */
  async duplicateTemplate(
    id: string,
    overrides: { userId?: string | null; namePrefix?: string } = {},
  ): Promise<BulkActionTemplate> {
    const original = await this.prisma.bulkActionTemplate.findUnique({
      where: { id },
    })
    if (!original) throw new Error(`Template not found: ${id}`)
    return this.prisma.bulkActionTemplate.create({
      data: {
        name: `${overrides.namePrefix ?? 'Copy of '}${original.name}`,
        description: original.description,
        actionType: original.actionType,
        channel: original.channel,
        actionPayload: original.actionPayload as any,
        defaultFilters: original.defaultFilters as any,
        parameters: original.parameters as any,
        category: original.category,
        userId: overrides.userId ?? null,
        isBuiltin: false,
      },
    })
  }

  /**
   * Substitute parameters into the template's actionPayload, returning
   * the final job-ready payload. Throws when a required parameter is
   * missing or fails validation. Pure-ish: no DB writes — caller bumps
   * usageCount via `recordUsage` once the job is created.
   */
  applyParameters(
    template: BulkActionTemplate,
    params: Record<string, unknown>,
    overrideFilters?: Record<string, unknown> | null,
  ): ApplyTemplateResult {
    const decls =
      (template.parameters as unknown as ParameterDecl[] | null) ?? []
    const resolved: Record<string, unknown> = {}
    for (const d of decls) {
      let v = params[d.name]
      if (v === undefined || v === '' || v === null) {
        v = d.defaultValue
      }
      if (v === undefined || v === null || v === '') {
        if (d.required) {
          throw new Error(`Required parameter missing: ${d.name}`)
        }
        resolved[d.name] = null
        continue
      }
      // Type coercion + bounds check. The wire types from a JSON
      // form are all strings unless the input was type=number — accept
      // both shapes here.
      if (d.type === 'number') {
        const n = typeof v === 'number' ? v : parseFloat(String(v))
        if (!Number.isFinite(n)) {
          throw new Error(`Parameter '${d.name}' must be a number`)
        }
        if (d.min !== undefined && n < d.min) {
          throw new Error(`Parameter '${d.name}' must be ≥ ${d.min}`)
        }
        if (d.max !== undefined && n > d.max) {
          throw new Error(`Parameter '${d.name}' must be ≤ ${d.max}`)
        }
        resolved[d.name] = n
      } else if (d.type === 'boolean') {
        resolved[d.name] = v === true || v === 'true' || v === '1'
      } else if (d.type === 'select') {
        const s = String(v)
        if (d.options && d.options.length > 0 && !d.options.includes(s)) {
          throw new Error(
            `Parameter '${d.name}' must be one of: ${d.options.join(', ')}`,
          )
        }
        resolved[d.name] = s
      } else {
        resolved[d.name] = String(v)
      }
    }

    return {
      actionPayload: substituteDeep(
        (template.actionPayload as Record<string, unknown>) ?? {},
        resolved,
      ) as Record<string, unknown>,
      filters: overrideFilters !== undefined
        ? overrideFilters
        : (template.defaultFilters as Record<string, unknown> | null) ?? null,
    }
  }

  /**
   * Bump usageCount + lastUsedAt. Called by the apply path after
   * BulkActionService.createJob succeeds. Best-effort — failure is
   * logged but doesn't abort the apply (telemetry shouldn't block
   * operator workflow).
   */
  async recordUsage(id: string): Promise<void> {
    try {
      await this.prisma.bulkActionTemplate.update({
        where: { id },
        data: {
          usageCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      })
    } catch {
      // swallow
    }
  }
}

/**
 * Walk a JSON value and replace any string of the form '${name}'
 * with the resolved parameter value. When the WHOLE string is
 * '${name}', the result is the typed value (number stays a number);
 * when '${name}' is embedded, the value is string-coerced and
 * spliced inline. Arrays + objects recurse.
 */
function substituteDeep(
  value: unknown,
  params: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const fullMatch = value.match(/^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/)
    if (fullMatch) {
      const name = fullMatch[1]
      return name in params ? params[name] : value
    }
    return value.replace(
      /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
      (_, name) =>
        name in params
          ? params[name] === null || params[name] === undefined
            ? ''
            : String(params[name])
          : `\${${name}}`,
    )
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, params))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, params)
    }
    return out
  }
  return value
}

// Export the helpers for unit-testing without spinning up Prisma.
export { substituteDeep as _substituteDeep }
