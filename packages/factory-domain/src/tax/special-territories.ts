/**
 * The EU's special fiscal territories (B-W2b-GF2, gap G463), pure: places of a member state that are outside the EU's VAT
 * area (Directive 2006/112/EC art. 6; for Italy DPR 633/1972 art. 7 c.1 a: Livigno and Campione d'Italia are not "the
 * territory of the State"), some of them outside the EU's customs territory too (Reg. (EU) 952/2013 art. 4), and one
 * country outside the EU that is inside both (Monaco, treated as France). A country code alone cannot tell them apart:
 * the address's postal code (and, where the code is shared, the town) does.
 *
 * What follows for goods sent there from Italy: a place outside the VAT area is an export for VAT (non-taxable, art. 8
 * DPR 633/1972) and takes export papers, even when it is inside the customs territory (a movement between fiscal
 * territories is declared to customs); an intra-EU supply (art. 41 DL 331/1993) never goes there. Monaco is an EU
 * destination (an intra-EU supply to France's VAT area).
 */

export const SPECIAL_TERRITORIES = ['LIVIGNO', 'CAMPIONE', 'CANARY_ISLANDS', 'CEUTA', 'MELILLA', 'MOUNT_ATHOS', 'HELIGOLAND', 'BUSINGEN', 'ALAND', 'FRENCH_OVERSEAS', 'FRENCH_OCT', 'MONACO'] as const
export type SpecialTerritoryKey = (typeof SPECIAL_TERRITORIES)[number]

export interface SpecialTerritory {
  readonly key: SpecialTerritoryKey
  /** The member state it belongs to (FR for Monaco). */
  readonly state: string
  /** Inside or outside the EU's VAT area. */
  readonly vat: 'INSIDE' | 'OUTSIDE'
  /** Inside or outside the EU's customs territory. */
  readonly customs: 'INSIDE' | 'OUTSIDE'
  readonly law: string
  readonly words: { readonly en: string; readonly it: string }
}

const OUT_OF_VAT = 'Directive 2006/112/EC art. 6'
const TERRITORIES: Readonly<Record<SpecialTerritoryKey, SpecialTerritory>> = Object.freeze({
  LIVIGNO: { key: 'LIVIGNO', state: 'IT', vat: 'OUTSIDE', customs: 'OUTSIDE', law: 'DPR 633/1972 art. 7 c.1 a; Reg. (EU) 952/2013 art. 4', words: { en: 'Livigno', it: 'Livigno' } },
  CAMPIONE: { key: 'CAMPIONE', state: 'IT', vat: 'OUTSIDE', customs: 'INSIDE', law: 'DPR 633/1972 art. 7 c.1 a; Reg. (EU) 2019/474', words: { en: "Campione d'Italia", it: "Campione d'Italia" } },
  CANARY_ISLANDS: { key: 'CANARY_ISLANDS', state: 'ES', vat: 'OUTSIDE', customs: 'INSIDE', law: OUT_OF_VAT, words: { en: 'the Canary Islands', it: 'le Isole Canarie' } },
  CEUTA: { key: 'CEUTA', state: 'ES', vat: 'OUTSIDE', customs: 'OUTSIDE', law: `${OUT_OF_VAT}; Reg. (EU) 952/2013 art. 4`, words: { en: 'Ceuta', it: 'Ceuta' } },
  MELILLA: { key: 'MELILLA', state: 'ES', vat: 'OUTSIDE', customs: 'OUTSIDE', law: `${OUT_OF_VAT}; Reg. (EU) 952/2013 art. 4`, words: { en: 'Melilla', it: 'Melilla' } },
  MOUNT_ATHOS: { key: 'MOUNT_ATHOS', state: 'GR', vat: 'OUTSIDE', customs: 'INSIDE', law: OUT_OF_VAT, words: { en: 'Mount Athos', it: 'il Monte Athos' } },
  HELIGOLAND: { key: 'HELIGOLAND', state: 'DE', vat: 'OUTSIDE', customs: 'OUTSIDE', law: `${OUT_OF_VAT}; Reg. (EU) 952/2013 art. 4`, words: { en: 'Heligoland', it: 'Helgoland' } },
  BUSINGEN: { key: 'BUSINGEN', state: 'DE', vat: 'OUTSIDE', customs: 'OUTSIDE', law: `${OUT_OF_VAT}; Reg. (EU) 952/2013 art. 4`, words: { en: 'Büsingen am Hochrhein', it: 'Büsingen am Hochrhein' } },
  ALAND: { key: 'ALAND', state: 'FI', vat: 'OUTSIDE', customs: 'INSIDE', law: OUT_OF_VAT, words: { en: 'the Åland Islands', it: 'le Isole Åland' } },
  FRENCH_OVERSEAS: { key: 'FRENCH_OVERSEAS', state: 'FR', vat: 'OUTSIDE', customs: 'INSIDE', law: OUT_OF_VAT, words: { en: "France's overseas departments", it: 'i dipartimenti francesi d’oltremare' } },
  FRENCH_OCT: { key: 'FRENCH_OCT', state: 'FR', vat: 'OUTSIDE', customs: 'OUTSIDE', law: `${OUT_OF_VAT}; Reg. (EU) 952/2013 art. 4`, words: { en: "France's overseas countries and territories", it: 'i paesi e territori francesi d’oltremare' } },
  MONACO: { key: 'MONACO', state: 'FR', vat: 'INSIDE', customs: 'INSIDE', law: 'Directive 2006/112/EC art. 7', words: { en: 'Monaco (treated as France)', it: 'Monaco (come la Francia)' } },
})

/** An address as the check reads it: the country code, and the postal code and town when known. */
export interface TerritoryAddress {
  readonly country: string | null | undefined
  readonly postalCode?: string | null | undefined
  readonly city?: string | null | undefined
}

const clean = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '')
const town = (value: string | null | undefined): string =>
  clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

/** The special fiscal territory an address is in, or null (an ordinary place of its country). */
export function specialTerritoryOf(address: TerritoryAddress): SpecialTerritory | null {
  const country = clean(address.country).toUpperCase()
  const code = clean(address.postalCode).replace(/\s+/g, '').toUpperCase()
  const city = town(address.city)
  const key = ((): SpecialTerritoryKey | null => {
    switch (country) {
      case 'IT':
        // Livigno's CAP is 23041 (23030 before, shared with other towns); Campione's 22061 (22060 before, shared).
        if (code === '23041' || (code === '23030' && city.includes('livigno')) || (code === '' && city.includes('livigno'))) return 'LIVIGNO'
        if (code === '22061' || ((code === '22060' || code === '') && city.includes('campione'))) return 'CAMPIONE'
        return null
      case 'ES':
        if (/^3[58]\d{3}$/.test(code)) return 'CANARY_ISLANDS'
        if (/^51\d{3}$/.test(code)) return 'CEUTA'
        if (/^52\d{3}$/.test(code)) return 'MELILLA'
        return null
      case 'IC':
        return 'CANARY_ISLANDS'
      case 'EA':
        return code.startsWith('52') || city.includes('melilla') ? 'MELILLA' : 'CEUTA'
      case 'GR':
        return code === '63086' || code === '63087' || city.includes('athos') || city.includes('agion oros') ? 'MOUNT_ATHOS' : null
      case 'DE':
        if (code === '27498' || city.includes('helgoland')) return 'HELIGOLAND'
        if (code === '78266' || city.includes('busingen')) return 'BUSINGEN'
        return null
      case 'FI':
        return /^22\d{3}$/.test(code) || /^AX-?22\d{3}$/.test(code) ? 'ALAND' : null
      case 'AX':
        return 'ALAND'
      case 'FR':
        // 971 Guadeloupe (97133 Saint-Barthélemy is a territory, not a department), 972 Martinique, 973 Guyane, 974 La
        // Réunion, 976 Mayotte; 975 Saint-Pierre-et-Miquelon and 986-988 the Pacific territories.
        if (code === '97133' || /^97[5]\d{2}$/.test(code) || /^98[6-8]\d{2}$/.test(code)) return 'FRENCH_OCT'
        if (/^97[1-46]\d{2}$/.test(code)) return 'FRENCH_OVERSEAS'
        return null
      case 'MC':
        return 'MONACO'
      default:
        return null
    }
  })()
  return key ? TERRITORIES[key] : null
}

/** Whether goods sent to this address leave the EU's VAT area (an export for VAT, with export papers), by its territory. */
export const outsideVatArea = (address: TerritoryAddress): boolean => specialTerritoryOf(address)?.vat === 'OUTSIDE'

/** The territory in words, with what it means for goods sent there from Italy (en, it). */
export function territoryWords(territory: SpecialTerritory): { readonly en: string; readonly it: string } {
  if (territory.vat === 'INSIDE') {
    return {
      en: `${territory.words.en}: inside the EU's VAT area and customs territory; goods go there as to another EU state (${territory.law}).`,
      it: `${territory.words.it}: dentro l’area IVA e il territorio doganale dell’UE; le merci ci vanno come in un altro Stato UE (${territory.law}).`,
    }
  }
  return territory.customs === 'INSIDE'
    ? {
        en: `${territory.words.en}: outside the EU's VAT area though inside its customs territory; goods sent there are an export for VAT and take export papers (${territory.law}).`,
        it: `${territory.words.it}: fuori dall’area IVA dell’UE pur dentro il suo territorio doganale; le merci spedite lì sono un’esportazione ai fini IVA e chiedono i documenti doganali (${territory.law}).`,
      }
    : {
        en: `${territory.words.en}: outside the EU's VAT area and customs territory; goods sent there are an export and take export papers (${territory.law}).`,
        it: `${territory.words.it}: fuori dall’area IVA e dal territorio doganale dell’UE; le merci spedite lì sono un’esportazione e chiedono i documenti doganali (${territory.law}).`,
      }
}
