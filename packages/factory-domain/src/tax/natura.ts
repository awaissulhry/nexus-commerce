/**
 * Natura codes: why a line carries no VAT (FatturaPA element 2.2.1.14 / 2.2.2.2; Specifiche tecniche FatturaPA v1.4,
 * schema VFPR12 v1.2.3). Since 1 January 2021 SDI refuses the generic parent codes N2, N3 and N6 (error 00445): only
 * the detailed codes below are accepted. DPR 633/1972 art. 21 c.6 requires the invoice to state the reason and the
 * law, which FatturaPA carries in RiferimentoNormativo next to the code.
 */
export const NATURA_CODES = [
  'N1',
  'N2.1',
  'N2.2',
  'N3.1',
  'N3.2',
  'N3.3',
  'N3.4',
  'N3.5',
  'N3.6',
  'N4',
  'N5',
  'N6.1',
  'N6.2',
  'N6.3',
  'N6.4',
  'N6.5',
  'N6.6',
  'N6.7',
  'N6.8',
  'N6.9',
  'N7',
] as const

export type NaturaCode = (typeof NATURA_CODES)[number]

/** Parent codes the schema still lists but SDI refuses (00445). */
export const RETIRED_NATURA_CODES = ['N2', 'N3', 'N6'] as const

/** The official description of each code (Specifiche tecniche, table of Natura values). */
export const NATURA_DESCRIPTIONS: Readonly<Record<NaturaCode, string>> = {
  N1: 'escluse ex art. 15 del DPR 633/72',
  'N2.1': 'non soggette ad IVA ai sensi degli artt. da 7 a 7-septies del DPR 633/72',
  'N2.2': 'non soggette - altri casi',
  'N3.1': 'non imponibili - esportazioni',
  'N3.2': 'non imponibili - cessioni intracomunitarie',
  'N3.3': 'non imponibili - cessioni verso San Marino',
  'N3.4': "non imponibili - operazioni assimilate alle cessioni all'esportazione",
  'N3.5': "non imponibili - a seguito di dichiarazioni d'intento",
  'N3.6': 'non imponibili - altre operazioni che non concorrono alla formazione del plafond',
  N4: 'esenti',
  N5: 'regime del margine / IVA non esposta in fattura',
  'N6.1': 'inversione contabile - cessione di rottami e altri materiali di recupero',
  'N6.2': "inversione contabile - cessione di oro e argento ai sensi della legge 7/2000 nonché di oreficeria usata ad OPO",
  'N6.3': 'inversione contabile - subappalto nel settore edile',
  'N6.4': 'inversione contabile - cessione di fabbricati',
  'N6.5': 'inversione contabile - cessione di telefoni cellulari',
  'N6.6': 'inversione contabile - cessione di prodotti elettronici',
  'N6.7': 'inversione contabile - prestazioni comparto edile e settori connessi',
  'N6.8': 'inversione contabile - operazioni settore energetico',
  'N6.9': 'inversione contabile - altri casi',
  N7: 'IVA assolta in altro stato UE (prestazione di servizi di telecomunicazioni, tele-radiodiffusione ed elettronici ex art. 7-octies, comma 1 lett. a, b, art. 74-sexies DPR 633/72)',
}

export function isNaturaCode(value: unknown): value is NaturaCode {
  return (NATURA_CODES as readonly unknown[]).includes(value)
}

/** Reverse-charge codes (inversione contabile): the buyer accounts for the VAT. */
export function isReverseCharge(natura: NaturaCode): boolean {
  return natura.startsWith('N6.')
}
