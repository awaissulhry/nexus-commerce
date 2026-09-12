/** Stable variation-axis identities, shared by source resolution and the product sheet. */
export function canonicalVariantAxis(value: string): string {
  const key = value.toLowerCase().replace(/[\s_-]/g, '')
  return ({ colore: 'color', colour: 'color', farbe: 'color', couleur: 'color',
    taglia: 'size', taille: 'size', talla: 'size', größe: 'size', groesse: 'size',
    stylename: 'style' } as Record<string, string>)[key] ?? key
}
