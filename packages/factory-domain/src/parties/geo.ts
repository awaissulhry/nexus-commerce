/**
 * The code lists a party's record is checked against (plan A1 §2.4 A; features SAL-001, SAL-003, SCM-001): countries
 * (ISO 3166-1 alpha-2), languages (ISO 639-1) and the Italian provinces (the two-letter sigla FatturaPA's Provincia and
 * a DDT carry). Pure data and lookups.
 */

const words = (list: string): readonly string[] => Object.freeze(list.trim().split(/\s+/))

/**
 * ISO 3166-1 alpha-2, every officially assigned code, plus XK (Kosovo: user-assigned, used by the EU and by carriers).
 * Greece is GR here; its VAT prefix EL is the tax module's business (./tax.ts).
 */
export const COUNTRY_CODES = words(`
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
  GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO
  JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR
  MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO
  RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV
  TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK
`)

/** ISO 639-1: the two-letter language codes (a party's documents and mail, a contact's language). */
export const LANGUAGE_CODES = words(`
  aa ab ae af ak am an ar as av ay az ba be bg bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo
  es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka
  kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng
  nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su
  sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu
`)

/**
 * The Italian provinces and metropolitan cities by their sigla (the vehicle-plate code ISTAT and the post use), with
 * the Sardinian codes of 2005-2016 (CI, OG, OT, VS) that the 2025 reorganisation of Sardinia's provinces brings back
 * into use: an address written with one is accepted.
 */
export const ITALIAN_PROVINCES = words(`
  AG AL AN AO AP AQ AR AT AV BA BG BI BL BN BO BR BS BT BZ CA CB CE CH CL CN CO CR CS CT CZ EN FC FE FG FI FM FR GE
  GO GR IM IS KR LC LE LI LO LT LU MB MC ME MI MN MO MS MT NA NO NU OR PA PC PD PE PG PI PN PO PR PT PU PV PZ RA RC
  RE RG RI RM RN RO SA SI SO SP SR SS SU SV TA TE TN TO TP TR TS TV UD VA VB VC VE VI VR VT VV CI OG OT VS
`)

const countries = new Set(COUNTRY_CODES)
const languages = new Set(LANGUAGE_CODES)
const provinces = new Set(ITALIAN_PROVINCES)

export const isCountryCode = (value: string): boolean => countries.has(value)
export const isLanguageCode = (value: string): boolean => languages.has(value)
export const isItalianProvince = (value: string): boolean => provinces.has(value)
