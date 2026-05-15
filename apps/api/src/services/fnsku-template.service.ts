import prisma from '../db.js'

export interface TemplateRow {
  id: string
  badgeText: string
  valueSource: 'productName' | 'color' | 'size' | 'gender' | 'sku' | 'asin' | 'custom'
  customValue: string
  show: boolean
  fontScale: number
  textTransform: 'uppercase' | 'none' | 'capitalize'
  boldValue: boolean
}

export interface TemplateConfig {
  labelSize: { widthMm: number; heightMm: number; preset: string }
  columnSplitPct: number
  paddingMm: number
  showColumnDivider: boolean
  logoUrl: string
  showLogo: boolean
  showSizeBox: boolean
  sizeBoxLabel?: string
  barcodeHeightPct: number
  barcodeWidthPct: number
  showListingTitle: boolean
  listingTitleLines: number
  showCondition: boolean
  condition: string
  fontFamily: string
  badgeFontScale: number
  valueFontScale: number
  sheetCols?: number
  sheetMarginMm?: number
  sheetGapMm?: number
  rows: TemplateRow[]
}

const DEFAULT_CONFIG: TemplateConfig = {
  labelSize: { widthMm: 101.6, heightMm: 76.2, preset: '4x3in' },
  columnSplitPct: 38,
  paddingMm: 2,
  showColumnDivider: true,
  logoUrl: '',
  showLogo: true,
  showSizeBox: true,
  sizeBoxLabel: 'SIZE',
  barcodeHeightPct: 32,
  barcodeWidthPct: 100,
  showListingTitle: true,
  listingTitleLines: 2,
  showCondition: true,
  condition: 'New',
  fontFamily: 'Helvetica',
  badgeFontScale: 1.0,
  valueFontScale: 1.0,
  rows: [
    { id: '1', badgeText: 'MODEL', valueSource: 'productName', customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
    { id: '2', badgeText: 'COLOR', valueSource: 'color',       customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
    { id: '3', badgeText: 'GEN.',  valueSource: 'gender',      customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
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
  return prisma.fnskuLabelTemplate.delete({ where: { id } })
}
