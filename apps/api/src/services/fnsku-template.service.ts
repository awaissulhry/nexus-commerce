import prisma from '../db.js'

export interface TemplateRow {
  id: string
  badgeText: string
  valueSource: 'productName' | 'color' | 'size' | 'gender' | 'sku' | 'custom'
  customValue: string
  show: boolean
}

export interface TemplateConfig {
  labelSize: { widthMm: number; heightMm: number; preset: string }
  logoUrl: string
  showLogo: boolean
  showSizeBox: boolean
  showListingTitle: boolean
  showCondition: boolean
  condition: string
  rows: TemplateRow[]
}

const DEFAULT_CONFIG: TemplateConfig = {
  labelSize: { widthMm: 101.6, heightMm: 76.2, preset: '4x3in' },
  logoUrl: '',
  showLogo: true,
  showSizeBox: true,
  showListingTitle: true,
  showCondition: true,
  condition: 'New',
  rows: [
    { id: '1', badgeText: 'MODEL', valueSource: 'productName', customValue: '', show: true },
    { id: '2', badgeText: 'COLOR', valueSource: 'color', customValue: '', show: true },
    { id: '3', badgeText: 'GEN.', valueSource: 'gender', customValue: '', show: true },
  ],
}

export async function listTemplates() {
  return prisma.fnskuLabelTemplate.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] })
}

export async function createTemplate(name: string, config?: Partial<TemplateConfig>) {
  const merged = { ...DEFAULT_CONFIG, ...config }
  return prisma.fnskuLabelTemplate.create({ data: { name, config: merged as any } })
}

export async function updateTemplate(id: string, data: { name?: string; config?: Partial<TemplateConfig>; isDefault?: boolean }) {
  if (data.isDefault) {
    await prisma.fnskuLabelTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
  }
  return prisma.fnskuLabelTemplate.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
      ...(data.config !== undefined && { config: data.config as any }),
    },
  })
}

export async function deleteTemplate(id: string) {
  await prisma.fnskuLabelTemplate.delete({ where: { id } })
}
