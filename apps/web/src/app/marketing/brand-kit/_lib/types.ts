// MC.10.1 — Brand Kit shared types.

export type ColorRole = 'primary' | 'secondary' | 'accent' | 'neutral' | 'status'
export type FontRole = 'heading' | 'body' | 'mono' | 'display'
export type LogoRole = 'primary' | 'mark' | 'wordmark' | 'monochrome' | 'inverse'

export interface ColorEntry {
  name: string
  hex: string
  role: ColorRole
}

export interface FontEntry {
  name: string
  family: string
  weight?: string
  role: FontRole
}

export interface LogoEntry {
  name: string
  assetId?: string
  url?: string
  role: LogoRole
}

export interface BrandKitRow {
  id: string
  brand: string
  displayName: string | null
  tagline: string | null
  voiceNotes: string | null
  colors: ColorEntry[]
  fonts: FontEntry[]
  logos: LogoEntry[]
  notes: string | null
  productCount: number
  createdAt: string
  updatedAt: string
  _count: {
    watermarks: number
  }
}

export interface BrandMetaRow {
  brand: string
  productCount: number
  hasKit: boolean
}

export const COLOR_ROLES: { value: ColorRole; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'secondary', label: 'Secondary' },
  { value: 'accent', label: 'Accent' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'status', label: 'Status' },
]

export const FONT_ROLES: { value: FontRole; label: string }[] = [
  { value: 'heading', label: 'Heading' },
  { value: 'body', label: 'Body' },
  { value: 'display', label: 'Display' },
  { value: 'mono', label: 'Mono' },
]

export const LOGO_ROLES: { value: LogoRole; label: string }[] = [
  { value: 'primary', label: 'Primary' },
  { value: 'mark', label: 'Mark only' },
  { value: 'wordmark', label: 'Wordmark only' },
  { value: 'monochrome', label: 'Monochrome' },
  { value: 'inverse', label: 'Inverse (for dark BG)' },
]
