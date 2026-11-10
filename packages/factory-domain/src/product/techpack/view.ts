import { asMoney } from '../../money/marked'
import type { TechPackBomLine, TechPackPicture, TechPackView } from './contracts'
import { isPartnerAudience, LEFT_OUT, LEFT_OUT_WORDS, leavesOut, SECTION_WORDS, showsKit, TECH_PACK_SECTIONS, type TechPackAudience, type TechPackLanguage, type TechPackSection } from './rules'

/**
 * The live tech pack of a style revision, built from what the API read (B-W2b-230; PRD-130, PRD-133, PRD-134, PRD-136,
 * PRD-147). Pure and deterministic: the same facts, audience, sections and language give the same view, and so the same
 * fingerprint (a PDF version is new only when what it says changed).
 *
 * The facts carry everything the office may see; `techPackViewOf` leaves out what the audience never gets (rules.ts LEFT_OUT):
 * absent keys, never blanked values. A section the caller may not see (its permission) is null with `allowed: false` and the
 * reason; a section not asked is null with `allowed: true`.
 */

type Money = string | null

/** A BOM line as the office sees it (every key filled; costs only when read for the cost grain). */
export interface BomLineFacts extends Omit<TechPackBomLine, 'material' | 'customerParty' | 'kit' | 'note' | 'supplierParty' | 'alternateMaterials' | 'unitCost' | 'lineCost'> {
  readonly material: { readonly code: string; readonly name: string; readonly kind: string; readonly approval: string }
  readonly customerParty: { readonly code: string; readonly name: string } | null
  readonly kit: boolean
  readonly note: string | null
  readonly supplierParty: { readonly code: string; readonly name: string } | null
  readonly alternateMaterials: readonly { readonly priority: number; readonly material: { readonly code: string; readonly name: string }; readonly allowedWhen: string }[]
  readonly unitCost?: Money
  readonly lineCost?: Money
}

type ViewOf<Key extends keyof TechPackView> = NonNullable<TechPackView[Key]>
type ConstructionView = ViewOf<'construction'>
type StepView = ConstructionView['steps'][number]
type ProtectionView = ViewOf<'protection'>
type TestView = ProtectionView['tests'][number]
type RevisionLogView = ViewOf<'revisionLog'>[number]
type VersionView = TechPackView['versions'][number]

export interface StepFacts extends Omit<StepView, 'standardMinutes' | 'workshopParty'> {
  readonly standardMinutes: string
  readonly workshopParty: { readonly code: string; readonly name: string } | null
}

export interface TestFacts extends Omit<TestView, 'testedBy'> {
  readonly testedBy: string | null
}

export interface RevisionLogFacts extends Omit<RevisionLogView, 'changeNote' | 'releasedBy'> {
  readonly changeNote: string | null
  readonly releasedBy: string | null
}

export interface VersionFacts extends Omit<VersionView, 'createdBy'> {
  readonly createdBy: string | null
}

export interface TechPackFacts {
  readonly style: TechPackView['style']
  readonly revision: Omit<TechPackView['revision'], 'changeNote'> & { readonly changeNote: string | null }
  readonly inForce: TechPackView['inForce']
  readonly pictures: readonly TechPackPicture[]
  readonly patterns: ConstructionView['patterns']
  readonly lines: readonly BomLineFacts[]
  readonly colourways: ViewOf<'colourways'>
  readonly sizeSpec: TechPackView['sizeSpec']
  /** null: the caller may not see the routing (its permission). */
  readonly construction: { readonly steps: readonly StepFacts[] } | null
  readonly labels: { readonly template: ViewOf<'labels'>['template']; readonly branding: ViewOf<'labels'>['branding'] }
  /** null: the caller may not see the certificates (its permission). */
  readonly protection: (Omit<ProtectionView, 'protectors' | 'tests'> & { readonly tests: readonly TestFacts[] }) | null
  readonly compliance: TechPackView['compliance']
  readonly revisions: readonly RevisionLogFacts[]
  readonly versions: readonly VersionFacts[]
}

export interface ViewOptions {
  readonly audience: TechPackAudience
  readonly language: TechPackLanguage
  /** The sections asked (rules.ts orderedSections). */
  readonly sections: readonly TechPackSection[]
  /** Why a section is not the caller's (its permission), in words; a section named here is shown as not allowed. */
  readonly notAllowed: Readonly<Partial<Record<TechPackSection, string>>>
}

/** The sections of a revision's BOM, in the BOM's section order, each line once (in grouped order: the facts' order). */
const BOM_SECTION_ORDER = ['SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'TRIMS', 'THREAD', 'LABELS', 'PACKAGING', 'OTHER']

/** A BOM line as the audience gets it. */
export function lineFor(line: BomLineFacts, audience: TechPackAudience): TechPackBomLine {
  const { material, customerParty, kit, note, supplierParty, alternateMaterials, unitCost, lineCost, ...rest } = line
  const partner = isPartnerAudience(audience)
  return {
    ...rest,
    bySize: rest.bySize.map((entry) => ({ ...entry })),
    colours: rest.colours.map((entry) => ({ ...entry })),
    material: partner ? { code: material.code, name: material.name, kind: material.kind } : { ...material },
    ...(leavesOut(audience, 'CUSTOMERS') ? {} : { customerParty }),
    ...(showsKit(audience) ? { kit } : {}),
    ...(leavesOut(audience, 'INTERNAL_NOTES') ? {} : { note }),
    ...(leavesOut(audience, 'SUPPLIERS') ? {} : { supplierParty }),
    ...(leavesOut(audience, 'ALTERNATES') ? {} : { alternateMaterials: alternateMaterials.map((entry) => ({ ...entry })) }),
    // Money only for the office, and only when the API read it (the cost grain); the serializer drops it for anyone else.
    ...(partner || unitCost === undefined ? {} : { unitCost: asMoney('cost', unitCost) }),
    ...(partner || lineCost === undefined ? {} : { lineCost: asMoney('cost', lineCost) }),
  }
}

function stepFor(step: StepFacts, audience: TechPackAudience): StepView {
  const { standardMinutes, workshopParty, ...rest } = step
  return {
    ...rest,
    settings: rest.settings.map((entry) => ({ ...entry })),
    instruction: rest.instruction ? { ...rest.instruction, steps: rest.instruction.steps.map((entry) => ({ ...entry })) } : null,
    ...(leavesOut(audience, 'MINUTES') ? {} : { standardMinutes }),
    ...(leavesOut(audience, 'SUPPLIERS') ? {} : { workshopParty }),
  }
}

/** The view of the live tech pack for an audience. */
export function techPackViewOf(facts: TechPackFacts, options: ViewOptions): TechPackView {
  const { audience } = options
  const asked = new Set(options.sections)
  const show = (section: TechPackSection): boolean => asked.has(section) && options.notAllowed[section] === undefined
  const partner = isPartnerAudience(audience)
  const lines = facts.lines.map((line) => lineFor(line, audience))
  const inSections = (sections: readonly string[]) => lines.filter((line) => sections.includes(line.section))

  const { changeNote, ...revision } = facts.revision
  const banner =
    facts.revision.status === 'DRAFT'
      ? `Revision ${facts.revision.revision} is a draft: it can change before it is released.`
      : facts.revision.status === 'OBSOLETE'
        ? `Revision ${facts.revision.revision} is obsolete${facts.inForce ? `: revision ${facts.inForce.revision} is in force` : ''}.`
        : null

  return {
    audience,
    language: options.language,
    sections: TECH_PACK_SECTIONS.map((section) => ({
      section,
      title: SECTION_WORDS[section],
      allowed: options.notAllowed[section] === undefined,
      included: show(section),
      why: options.notAllowed[section] ?? null,
    })),
    leftOut: LEFT_OUT[audience].map((kind) => ({ kind, words: LEFT_OUT_WORDS[kind] })),
    style: { ...facts.style, sizes: facts.style.sizes.map((size) => ({ ...size })), brand: facts.style.brand ? { ...facts.style.brand } : null },
    revision: { ...revision, ...(leavesOut(audience, 'INTERNAL_NOTES') ? {} : { changeNote }) },
    inForce: facts.inForce ? { ...facts.inForce } : null,
    banner,
    sketches: show('SKETCHES') ? facts.pictures.filter((picture) => picture.kind !== 'PAGE').map(copyPicture) : null,
    bom: show('BOM')
      ? {
          sections: BOM_SECTION_ORDER.flatMap((section) => {
            const of = lines.filter((line) => line.section === section)
            return of.length === 0 ? [] : [{ section, lines: of }]
          }),
          lines: lines.length,
        }
      : null,
    colourways: show('COLOURWAYS') ? facts.colourways.map((colourway) => ({ ...colourway, colour: colourway.colour ? { ...colourway.colour } : null, colours: colourway.colours.map((entry) => ({ ...entry })) })) : null,
    sizeSpec: show('SIZE_SPEC') && facts.sizeSpec ? { ...facts.sizeSpec, sizes: [...facts.sizeSpec.sizes], points: facts.sizeSpec.points.map((point) => ({ ...point, values: point.values.map((value) => (value ? { ...value } : null)) })) } : null,
    construction:
      show('CONSTRUCTION') && facts.construction
        ? {
            steps: facts.construction.steps.map((step) => stepFor(step, audience)),
            pages: facts.pictures.filter((picture) => picture.kind === 'PAGE').map(copyPicture),
            patterns: facts.patterns.map((entry) => ({ ...entry, sizes: [...entry.sizes] })),
          }
        : null,
    labels: show('LABELS')
      ? {
          template: facts.labels.template ? { ...facts.labels.template } : null,
          lines: inSections(['LABELS', 'PACKAGING']),
          branding: facts.labels.branding ? { ...facts.labels.branding, rules: facts.labels.branding.rules.map((rule) => ({ ...rule })) } : null,
        }
      : null,
    protection:
      show('PROTECTION') && facts.protection
        ? {
            ...facts.protection,
            placements: facts.protection.placements.map((entry) => ({ ...entry, sizes: [...entry.sizes] })),
            protectors: inSections(['PROTECTION']),
            certificates: facts.protection.certificates.map((entry) => ({ ...entry, colourways: [...entry.colourways], sizes: [...entry.sizes], performanceLevels: { ...entry.performanceLevels } })),
            tests: facts.protection.tests.map(({ testedBy, ...test }) => ({ ...test, ...(leavesOut(audience, 'PEOPLE') ? {} : { testedBy }) })),
          }
        : null,
    compliance: show('COMPLIANCE') && facts.compliance ? { ...facts.compliance, documents: facts.compliance.documents.map((entry) => ({ ...entry })), blockers: [...facts.compliance.blockers] } : null,
    revisionLog: show('REVISION_LOG')
      ? facts.revisions.map(({ changeNote: note, releasedBy, ...entry }) => ({
          ...entry,
          ...(leavesOut(audience, 'INTERNAL_NOTES') ? {} : { changeNote: note }),
          ...(leavesOut(audience, 'PEOPLE') ? {} : { releasedBy }),
        }))
      : null,
    versions: partner ? [] : facts.versions.map((entry) => ({ ...entry })),
  }
}

const copyPicture = (picture: TechPackPicture): TechPackPicture => ({ ...picture, colourway: picture.colourway ? { ...picture.colourway } : null, callouts: picture.callouts.map((entry) => ({ ...entry })) })

/**
 * What a PDF version says, as stable text (its fingerprint's input, hashed by the API): the view without the stored versions
 * (they are not printed) and without money (a PDF carries none), with the party it is for. Keys in a fixed order.
 */
export function fingerprintTextOf(view: TechPackView, party: { readonly code: string; readonly name: string } | null): string {
  const { versions: _versions, ...printed } = view
  return stableJson({ printed: withoutMoney(printed), party })
}

/** A value with every key a money field could have taken left out (the PDF's rule). */
export function withoutMoney<Value>(value: Value): Value {
  if (Array.isArray(value)) return value.map((entry) => withoutMoney(entry)) as Value
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'unitCost' && key !== 'lineCost')
        .map(([key, entry]) => [key, withoutMoney(entry)]),
    ) as Value
  }
  return value
}

/** JSON with every object's keys sorted (the same view gives the same text). */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}
