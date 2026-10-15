/**
 * Google Ads changes (2026-10-15) — PR 5, campaign assets of ONE campaign: make sitelinks, callouts and structured
 * snippets and link them to the campaign, link existing assets again, and unlink assets (the link goes, the asset stays
 * in the account). One atomic request: the new assets carry temporary ids (-1, -2 …) and their links point at them.
 *
 * Money: an asset raises no bid and no budget (no SPENDS MONEY). Unlinking one means the ads show without it: said in
 * the warnings. An asset already linked with the same text is skipped, not made twice.
 *
 * Checked 2026-10-15 in Google's v25 reference (developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   SitelinkAsset        link_text required, 1–25; description1 and description2 1–35 each, "description2 must also be
 *                        set" (both or neither). The sitelink's address is the Asset's final_urls.
 *   CalloutAsset         callout_text required, 1–25.
 *   StructuredSnippetAsset  header required, "one of the predefined values" of Google's header list; values 3–10, each
 *                        1–25.
 *   AssetOperation       create (an asset is never removed through the API: unlink it from the campaign).
 *   CampaignAsset        campaign, asset, field_type (AssetFieldType SITELINK / CALLOUT / STRUCTURED_SNIPPET), all
 *                        immutable; resource name customers/{c}/campaignAssets/{campaign_id}~{asset_id}~{field_type};
 *                        CampaignAssetOperation remove takes that resource name.
 *   AssetError DUPLICATE_ASSET "Assets are duplicated across operations": the same asset twice in a request is refused.
 *   MutateOperationResponse  asset_result, campaign_asset_result (JSON assetResult, campaignAssetResult).
 * Structured snippet headers (developers.google.com/google-ads/api/data/structured-snippet-headers, 2026-10-15): "The
 * header value must match one of the exact translated strings for that locale". Google Ads Help (answer 6280012): the
 * person chooses "a language and header", and the values are written in that language; the English (US) list is Help's
 * (Service catalog, Featured hotels). Google's snippet policy (adspolicy answer 6283300): a value may not repeat "in the
 * same header or across different headers".
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem, textKey, widthProblem } from './change-ads.js'
import type { LiveAsset, LiveCampaign } from './live.js'
import type { LiveAccountAsset } from './live-ads-assets.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export const ASSET_FIELD_TYPES = ['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET'] as const
export type AssetFieldType = typeof ASSET_FIELD_TYPES[number]

export const ASSET_LIMITS = { linkText: 25, sitelinkDescription: 35, callout: 25, snippetValue: 25, minSnippetValues: 3, maxSnippetValues: 10 } as const

// ── structured snippet headers, per language ────────────────────────────────────────────────────────────────────

/** The English name of each header, in the column order of the table below. */
export const SNIPPET_HEADER_NAMES = [
  'Brands', 'Amenities', 'Styles', 'Types', 'Destinations', 'Services', 'Courses', 'Neighborhoods', 'Shows', 'Insurance coverage',
  'Degree programs', 'Featured hotels', 'Models',
] as const

/**
 * Google's headers per locale: [language, the 13 headers in SNIPPET_HEADER_NAMES order, joined by "|"]. Copied from
 * Google's localized headers table (an empty header: Google has none for that language). `en` is English (US).
 */
const SNIPPET_HEADERS: Record<string, [string, string]> = {
  en: ["English", "Brands|Amenities|Styles|Types|Destinations|Service catalog|Courses|Neighborhoods|Shows|Insurance coverage|Degree programs|Featured hotels|Models"],
  ar: ["Arabic", "العلامات التجارية|وسائل الراحة|الأنماط|الأنواع|الوجهات|الخدمات|الدورات التدريبية|الأحياء|العروض|التغطية التأمينية|برامج الشهادات|الفنادق المميّزة|النماذج"],
  bg: ["Bulgarian", "Марки|Удобства|Стилове|Типове|Дестинации|Услуги|Курсове|Квартали|Предавания|Застраховка|Специалности|Представени хотели|Модели"],
  ca: ["Catalan", "Marques|Serveis addicionals|Estils|Tipus|Destinacions|Serveis|Cursos|Barris|Programes|Assegurança|Titulacions|Hotels destacats|Models"],
  'zh-HK': ["Chinese (Hong Kong)", "品牌|設施|款式|類型|目的地|服務|課程|社區|節目|保障範圍|學位課程|特色酒店|型號"],
  'zh-CN': ["Chinese (Simplified)", "品牌|设施|款式|类型|目的地|服务|课程|社区|节目|险种|学位课程|精选酒店|型号"],
  'zh-TW': ["Chinese (Traditional)", "品牌|設施|款式|類型|目的地|服務|課程|社區|節目|承保範圍|學位課程|精選飯店|型號"],
  hr: ["Croatian", "Robne marke|Sadržaji|Stilovi|Vrste|Odredišta|Usluge|Tečajevi|Četvrti|Emisije|Osiguranje|Studijski programi|Istaknuti hoteli|Modeli"],
  cs: ["Czech", "Značky|Vybavení|Styly|Typy|Cíle|Služby|Kurzy|Známé oblasti|Pořady|Pojištění|Studijní programy|Vybrané hotely|Modely"],
  da: ["Danish", "Brands|Faciliteter|Design|Typer|Destinationer|Tjenester|Kurser|Nabolag|Serier|Forsikringsdækning|Uddannelser|Udvalgte hoteller|Modeller"],
  nl: ["Dutch", "Merken|Voorzieningen|Stijlen|Typen|Bestemmingen|Services|Cursussen|Buurten|Shows|Dekking|Studieprogramma's|Aanbevolen hotels|Modellen"],
  'en-AU': ["English (Australia)", "Brands|Amenities|Styles|Types|Destinations|Services|Courses|Neighbourhoods|Shows|Insurance coverage|Degree programmes|Featured hotels|Models"],
  'en-GB': ["English (UK)", "Brands|Amenities|Styles|Types|Destinations|Services|Courses|Neighbourhoods|Shows|Insurance coverage|Degree programmes|Featured hotels|Models"],
  et: ["Estonian", "Brändid|Mugavusteenused|Stiilid|Tüübid|Sihtkohad|Teenused|Kursused|Ümbruskonnad|Saated ja etendused|Kindlustuskaitse|Kraadiõppeprogrammid|Soovitatud hotellid|Mudelid"],
  fil: ["Filipino", "Mga Brand|Mga Amenity|Mga Istilo|Mga Uri|Mga Destinasyon|Mga Serbisyo|Mga Kurso|Mga Komunidad|Mga Palabas|Sakop ng insurance|Mga degree program|Itinatampok na hotel|Mga Modelo"],
  fi: ["Finnish", "Brändit|Lisäpalvelut|Tyylit|Tyypit|Kohteet|Palvelut|Kurssit|Kaupunginosat|Show't|Vakuutukset|Oppiaineet|Suositellut hotellit|Automerkit"],
  fr: ["French (France)", "Marques|Équipements|Styles|Types|Destinations|Services|Cours|Quartiers|Émissions|Couverture d'assurance|Programmes d'études|Sélection d'hôtels|Modèles"],
  de: ["German", "Marken|Ausstattung|Stile|Typen|Ziele|Dienstleistungen|Kurse|Viertel|Serien|Versicherungsleistung|Studiengänge|Vorgestellte Hotels|Modelle"],
  el: ["Greek", "Επωνυμίες|Παροχές|Στυλ|Τύποι|Προορισμοί|Υπηρεσίες|Μαθήματα|Γειτονιές|Εκπομπές|Ασφαλιστική κάλυψη|Προγράμματα πτυχίων|Ξενοδοχεία|Μοντέλα"],
  iw: ["Hebrew", "מותגים|שירותי המקום|סגנונות|סוגים|יעדים גיאוגרפיים|שירותים|קורסים|שכונות|הופעות ותוכניות|כיסוי ביטוחי|תוכניות ללימודי תואר|מלונות מומלצים|דגמים"],
  hi: ["Hindi", "ब्रांड|सुविधाएं|शैलियां|प्रकार|गंतव्य|सेवाएं|पाठ्‍यक्रम|आस-पड़ोस|शो|बीमा कवरेज|डिग्री कार्यक्रम|प्रदर्शित होटल|मॉडल"],
  hu: ["Hungarian", "Márkák|Szolgáltatások|Stílusok|Típusok|Úti célok|Szolgáltatások|Tanfolyamok|Városrészek|Műsorok|Biztosítási módozat|Diplomaprogramok|Kiemelt szállodák|Modellek"],
  id: ["Indonesian", "Merek|Fasilitas|Gaya|Jenis|Destinasi|Layanan|Mata pelajaran|Kawasan|Acara|Cakupan asuransi|Program sarjana|Hotel pilihan|Model"],
  it: ["Italian", "Brand|Servizi|Stili|Tipi|Destinazioni|Servizi|Corsi|Quartieri|Programmi|Coperture assicurativa|Corsi di laurea|Hotel consigliati|Modelli"],
  ja: ["Japanese", "ブランド|設備|スタイル|タイプ|到着地|サービス|コース|周辺地域|番組|保険の保障|学位プログラム|おすすめのホテル|モデル"],
  ko: ["Korean", "브랜드|편의 시설|스타일|유형|목적지|서비스|과정|인근 지역|프로그램|보험 보상 범위|학위 취득 프로그램|추천 호텔|모델"],
  lv: ["Latvian", "Zīmoli|Ērtības|Stili|Veidi|Galamērķi|Pakalpojumi|Kursi|Apkaimes|Pārraides|Apdrošināšana|Studiju programmas|Piedāvātās viesnīcas|Modeļi"],
  lt: ["Lithuanian", "Prekių ženklai|Patogumai|Stiliai|Tipai|Paskirties vietos|Paslaugos|Kursai|Namų apylinkės|Laidos|Draudimo aprėptis|Moksliniai laipsniai|Siūlomi viešbučiai|Modeliai"],
  ms: ["Malay", "Jenama|Kemudahan|Gaya|Jenis|Destinasi|Perkhidmatan|Kursus|Kejiranan|Rancangan|Liputan insurans|Program ijazah|Hotel ditampilkan|Model"],
  no: ["Norwegian", "Merkevarer|Fasiliteter|Stiler|Typer|Destinasjoner|Tjenester|Kurs|Lokalområder|Programmer|Forsikringsdekning|Utdanningsprogrammer|Utvalgte hoteller|Modeller"],
  pl: ["Polish", "Marki|Udogodnienia|Style|Typy|Miejsca|Usługi|Kursy|Dzielnice|Programy|Ubezpieczenia|Kierunki studiów|Polecane hotele|Modele"],
  'pt-BR': ["Portuguese (Brazil)", "Marcas|Comodidades|Estilos|Tipos|Destinos|Serviços|Cursos|Bairros|Programas|Cobertura do seguro|Programas de graduação|Hotéis em destaque|Modelos"],
  'pt-PT': ["Portuguese (Portugal)", "Marcas|Comodidades|Estilos|Tipos|Destinos|Serviços|Cursos|Arredores|Programas|Cobertura do seguro|Licenciaturas|Hotéis em destaque|Modelos"],
  ro: ["Romanian", "Mărci|Dotări|Stiluri|Tipuri|Destinații|Servicii|Cursuri|Cartiere|Emisiuni|Asigurare|Programe de studiu|Hoteluri prezentate|Modele"],
  ru: ["Russian", "Бренды|Удобства|Стили|Типы|Места|Услуги|Курсы|Районы|Шоу|Страховая защита|Программы высшего образования|Рекомендуемые отели|Модели"],
  sr: ["Serbian", "брендови|садржаји|стилови|типови|дестинације|услуге|курсеви|делови града|емисије|осигурање|дипломе|истакнути хотели|модели"],
  sk: ["Slovak", "Značky|Vybavenie|Štýly|Typy|Destinácie|Služby|Kurzy|Štvrte|Relácie|Poistenie|Vzdelávacie programy|Odporúčané hotely|Modely"],
  sl: ["Slovenian", "Blagovne znamke|Ponudba|Slogi|Vrste|Cilji|Storitve|Tečaji|Soseske|Oddaje|Kritje zavarovanj|Študijski programi|Predstavljeni hoteli|Modeli"],
  'es-419': ["Spanish (Latin America)", "Marcas|Servicios adicionales|Estilos|Tipos|Destinos|Servicios|Cursos|Barrios|Programas|Cobertura de seguro|Carreras universitarias|Hoteles destacados|Modelos"],
  es: ["Spanish (Spain)", "Marcas|Servicios adicionales|Estilos|Tipos|Destinos|Servicios|Cursos||Espectáculos|Cobertura de seguro|Carreras universitarias|Hoteles destacados|Modelos"],
  sv: ["Swedish", "Varumärken|Faciliteter|Stilar|Typer|Resmål|Tjänster|Kurser|Barrios|Program|Försäkringstyper|Utbildningsprogram|Utvalda hotell|Modeller"],
  th: ["Thai", "แบรนด์|สิ่งอำนวยความสะดวก|สไตล์|ประเภท|ปลายทาง|บริการ|หลักสูตร|ย่านใกล้เคียง|โชว์|ความคุ้มครองในประกัน|หลักสูตรปริญญา|โรงแรมเด่น|รุ่น"],
  tr: ["Turkish", "Markalar|Sunulan olanaklar|Stiller|Türler|destinasyonlar|Hizmetler|Kurslar|Mahalleler|Programlar|Sigorta kapsamı|Lisans programları|Öne çıkan oteller|Modeller"],
  uk: ["Ukrainian", "Бренди|Зручності|Стилі|Типи|Місця|Послуги|Курси|Квартали|Шоу|Страховий захист|Освітні програми|Рекомендовані готелі|Моделі"],
  vi: ["Vietnamese", "Thương hiệu|Tiện nghi|Kiểu|Loại|Điểm đến|Dịch vụ|Khóa học|Vùng lân cận|Chương trình|Phạm vi bảo hiểm|Cấp bằng|Khách sạn nổi bật|Model"],
}

export const SNIPPET_LANGUAGES = Object.keys(SNIPPET_HEADERS)

/** The headers Google takes in a language (empty ones left out), or null for a language Google has no headers for. */
export function snippetHeaders(language: string): { language: string; headers: string[] } | null {
  const key = SNIPPET_LANGUAGES.find((l) => l.toLowerCase() === language.trim().toLowerCase())
  if (!key) return null
  const [name, joined] = SNIPPET_HEADERS[key]
  return { language: name, headers: joined.split('|') }
}

/**
 * The header Google takes for what was asked: the language's own header (any case; sent as Google writes it), or the
 * English name of a header ("Types"), sent as the language's header ("Tipi" in Italian).
 */
export function snippetHeader(asked: string, language = 'en'): { header: string } | { problem: string } {
  const row = snippetHeaders(language)
  if (!row) return { problem: `language "${language}" is not one Google has snippet headers for (${SNIPPET_LANGUAGES.join(', ')})` }
  const want = textKey(asked)
  const own = row.headers.find((h) => h && textKey(h) === want)
  if (own) return { header: own }
  const english = want === 'service catalog' ? 'services' : want
  const column = SNIPPET_HEADER_NAMES.findIndex((n) => n.toLowerCase() === english)
  if (column >= 0 && row.headers[column]) return { header: row.headers[column] }
  return { problem: `header "${asked.trim()}" is not one of Google's headers in ${row.language} (${[...new Set(row.headers.filter(Boolean))].join(', ')})` }
}

// ── the change ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface SitelinkRequest { linkText: string; description1?: string | null; description2?: string | null; finalUrl: string }
export interface SnippetRequest { header: string; language?: string | null; values: string[] }
export interface AssetRef { assetId: string; fieldType: AssetFieldType }

export interface AssetsChangeRequest {
  campaignId: string
  sitelinks?: SitelinkRequest[]
  callouts?: string[]
  structuredSnippets?: SnippetRequest[]
  /** Existing assets of the account to link to the campaign (again): the undo of an unlink. */
  linkAssets?: AssetRef[]
  /** Links to take off the campaign (the asset stays in the account). */
  unlinkAssets?: AssetRef[]
}

export interface AssetsLiveState {
  /** The campaign; null when it is not in the account (or removed). */
  campaign: LiveCampaign | null
  /** The campaign's asset links (not removed). */
  linked: LiveAsset[]
  /** The assets `linkAssets` names, read by id. */
  assets: LiveAccountAsset[]
}

/** One link the change made or took away; `assetId` is `op:<index>` for a new asset until Google gave its id. */
export interface AssetLink { assetId: string; fieldType: AssetFieldType; text: string }
export interface AssetsChangeRecord { campaignId: string; linked: AssetLink[]; unlinked: AssetLink[] }
/** What it replaced: the links it took away. */
export interface AssetsChangeBefore { campaignId: string; links: AssetLink[] }

const OP = 'op:'
const KIND: Record<AssetFieldType, string> = { SITELINK: 'sitelink', CALLOUT: 'callout', STRUCTURED_SNIPPET: 'structured snippet' }
const isFieldType = (v: unknown): v is AssetFieldType => ASSET_FIELD_TYPES.includes(v as AssetFieldType)

/** What an asset reads as, to a person: its text, or a snippet's header and values. */
function labelOf(asset: { text?: string | null; header?: string | null; values?: string[] }, fieldType: string | null): string {
  if (fieldType === 'STRUCTURED_SNIPPET') return `${asset.header ?? ''}: ${(asset.values ?? []).join(', ')}`
  return asset.text ?? ''
}
/** Two assets of a kind are the same when their text reads the same (a snippet: same header, same values). */
function sameKey(fieldType: string | null, asset: { text?: string | null; header?: string | null; values?: string[] }): string {
  if (fieldType === 'STRUCTURED_SNIPPET') return `${fieldType}:${textKey(asset.header)}|${(asset.values ?? []).map(textKey).sort().join('|')}`
  return `${fieldType}:${textKey(asset.text)}`
}
const linkKey = (assetId: string, fieldType: string | null) => `${assetId}~${fieldType}`

export function assetsChangeDraft(customer: string, request: AssetsChangeRequest, live: AssetsLiveState): GoogleChangeDraft | { refusal: string } {
  const sitelinks = request.sitelinks ?? []
  const callouts = request.callouts ?? []
  const snippets = request.structuredSnippets ?? []
  const relink = request.linkAssets ?? []
  const unlink = request.unlinkAssets ?? []
  if (sitelinks.length + callouts.length + snippets.length + relink.length + unlink.length === 0) {
    return { refusal: 'Say what to change: sitelinks, callouts, structuredSnippets (new assets to link), linkAssets or unlinkAssets.' }
  }

  // 1. Google's text rules, every problem at once.
  const problems: string[] = []
  const L = ASSET_LIMITS
  sitelinks.forEach((s, i) => {
    const where = `sitelink ${i + 1}`
    const text = widthProblem(`${where}, link text`, s.linkText, L.linkText)
    if (text) problems.push(text)
    const d1 = s.description1?.trim() ?? ''
    const d2 = s.description2?.trim() ?? ''
    if (!!d1 !== !!d2) problems.push(`${where}: give description1 and description2 both, or neither (Google's rule)`)
    if (d1) { const p = widthProblem(`${where}, description1`, d1, L.sitelinkDescription); if (p) problems.push(p) }
    if (d2) { const p = widthProblem(`${where}, description2`, d2, L.sitelinkDescription); if (p) problems.push(p) }
    const url = httpsUrlProblem(where, s.finalUrl)
    if (url) problems.push(url)
  })
  callouts.forEach((c, i) => { const p = widthProblem(`callout ${i + 1}`, c, L.callout); if (p) problems.push(p) })
  const headers: string[] = []
  const valueSeen = new Map<string, string>()
  snippets.forEach((s, i) => {
    const where = `structured snippet ${i + 1}`
    const header = snippetHeader(s.header, s.language?.trim() || 'en')
    if ('problem' in header) problems.push(`${where}: ${header.problem}`)
    headers.push('header' in header ? header.header : s.header.trim())
    if (s.values.length < L.minSnippetValues || s.values.length > L.maxSnippetValues) {
      problems.push(`${where}: ${plural(s.values.length, 'value')} (Google needs ${L.minSnippetValues} to ${L.maxSnippetValues})`)
    }
    s.values.forEach((v, j) => {
      const p = widthProblem(`${where}, value ${j + 1}`, v, L.snippetValue)
      if (p) { problems.push(p); return }
      const key = textKey(v)
      const first = valueSeen.get(key)
      if (first) problems.push(`${where}, value ${j + 1} "${v.trim()}" repeats ${first} (Google's policy refuses a value repeated in a header or across headers)`)
      else valueSeen.set(key, `${where}, value ${j + 1}`)
    })
  })
  for (const ref of [...relink, ...unlink]) if (!isFieldType(ref.fieldType)) problems.push(`asset ${ref.assetId}: field type ${String(ref.fieldType)} is not ${ASSET_FIELD_TYPES.join(', ')}`)
  const unlinkKeys = new Set(unlink.map((r) => linkKey(r.assetId, r.fieldType)))
  for (const r of relink) if (unlinkKeys.has(linkKey(r.assetId, r.fieldType))) problems.push(`asset ${r.assetId} (${r.fieldType}) is both linked and unlinked`)
  if (problems.length) return { refusal: `Not queued — the assets break Google's rules (nothing was sent): ${problems.join('; ')}.` }

  // 2. The campaign and what it holds now.
  const campaign = live.campaign
  if (!campaign) return { refusal: `Campaign ${request.campaignId} is not in this account (or it is removed). google-ads-live view campaigns lists them.` }
  const campaignRes = `${customer}/campaigns/${campaign.campaignId}`
  const linkedNow = new Map(live.linked.filter((a) => isFieldType(a.fieldType)).map((a) => [linkKey(a.assetId, a.fieldType), a]))
  const sameNow = new Set(live.linked.map((a) => sameKey(a.fieldType, a)))
  const assetById = new Map(live.assets.map((a) => [a.assetId, a]))

  const operations: GoogleMutateOperation[] = []
  const links: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const warnings: string[] = []
  const record: AssetsChangeRecord = { campaignId: campaign.campaignId, linked: [], unlinked: [] }
  const made = { SITELINK: 0, CALLOUT: 0, STRUCTURED_SNIPPET: 0 }
  let tempId = -1

  // 3. New assets, each linked to the campaign (an asset first, its link after every asset).
  const add = (fieldType: AssetFieldType, asset: Record<string, unknown>, label: { text?: string; header?: string; values?: string[] }, to: string) => {
    const key = sameKey(fieldType, label)
    const text = labelOf(label, fieldType)
    if (sameNow.has(key)) { skipped.push(`A ${KIND[fieldType]} "${text}" is already linked to "${campaign.name}".`); return }
    sameNow.add(key)
    const resourceName = `${customer}/assets/${tempId--}`
    operations.push({ assetOperation: { create: { resourceName, ...asset } } })
    links.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: resourceName, fieldType } } })
    record.linked.push({ assetId: `${OP}${operations.length - 1}`, fieldType, text })
    lines.push([`${KIND[fieldType]} "${text}"`, '(none)', to])
    made[fieldType] += 1
  }
  for (const s of sitelinks) {
    const d1 = s.description1?.trim()
    const d2 = s.description2?.trim()
    add('SITELINK', { finalUrls: [s.finalUrl.trim()], sitelinkAsset: { linkText: s.linkText.trim(), ...(d1 && d2 ? { description1: d1, description2: d2 } : {}) } },
      { text: s.linkText.trim() }, `new, linked — ${s.finalUrl.trim()}${d1 && d2 ? ` · ${d1} / ${d2}` : ''}`)
  }
  for (const c of callouts) add('CALLOUT', { calloutAsset: { calloutText: c.trim() } }, { text: c.trim() }, 'new, linked')
  snippets.forEach((s, i) => {
    const values = s.values.map((v) => v.trim())
    add('STRUCTURED_SNIPPET', { structuredSnippetAsset: { header: headers[i], values } }, { header: headers[i], values }, `new, linked — ${values.join(', ')}`)
  })
  operations.push(...links)

  // 4. Existing assets linked (again).
  for (const ref of relink) {
    const key = linkKey(ref.assetId, ref.fieldType)
    if (record.linked.some((l) => linkKey(l.assetId, l.fieldType) === key)) continue
    const asset = assetById.get(ref.assetId)
    if (!asset) return { refusal: `Asset ${ref.assetId} is not in this account.` }
    if (asset.type !== ref.fieldType) return { refusal: `Asset ${ref.assetId} is a ${asset.type ?? 'asset of another kind'}, not a ${KIND[ref.fieldType]}.` }
    const text = labelOf(asset, ref.fieldType)
    if (linkedNow.has(key)) { skipped.push(`The ${KIND[ref.fieldType]} "${text}" (asset ${ref.assetId}) is already linked to "${campaign.name}".`); continue }
    operations.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: `${customer}/assets/${ref.assetId}`, fieldType: ref.fieldType } } })
    record.linked.push({ assetId: ref.assetId, fieldType: ref.fieldType, text })
    lines.push([`${KIND[ref.fieldType]} "${text}" (asset ${ref.assetId})`, 'not linked', 'linked'])
  }

  // 5. Links taken off the campaign (the asset stays).
  for (const ref of unlink) {
    const key = linkKey(ref.assetId, ref.fieldType)
    if (record.unlinked.some((l) => linkKey(l.assetId, l.fieldType) === key)) continue
    const link = linkedNow.get(key)
    if (!link) { skipped.push(`Asset ${ref.assetId} is not linked to "${campaign.name}" as a ${KIND[ref.fieldType]}.`); continue }
    const text = labelOf(link, ref.fieldType)
    operations.push({ campaignAssetOperation: { remove: `${customer}/campaignAssets/${campaign.campaignId}~${ref.assetId}~${ref.fieldType}` } })
    record.unlinked.push({ assetId: ref.assetId, fieldType: ref.fieldType, text })
    lines.push([`${KIND[ref.fieldType]} "${text}" (asset ${ref.assetId})`, 'linked', 'unlinked (the ads show without it)'])
  }
  if (record.unlinked.length) {
    const n = record.unlinked.length
    warnings.push(`Unlinking ${plural(n, 'asset')} from "${campaign.name}": its ads show without ${n === 1 ? 'it' : 'them'} (the asset stays in the account).`)
  }

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const relinked = record.linked.filter((l) => !l.assetId.startsWith(OP)).length
  const parts: string[] = []
  const madeParts = (Object.keys(made) as AssetFieldType[]).filter((k) => made[k] > 0).map((k) => plural(made[k], `new ${KIND[k]}`))
  if (madeParts.length) parts.push(`make and link ${madeParts.join(', ')}`)
  if (relinked) parts.push(`link ${plural(relinked, 'existing asset')}`)
  if (record.unlinked.length) parts.push(`unlink ${plural(record.unlinked.length, 'asset')}`)
  const { changes, more } = changeLines(lines)
  const asked = [...relink, ...unlink].map((r) => r.assetId)
  return {
    summary: `Google Ads assets of campaign "${campaign.name}": ${parts.join('; ')}.`,
    changes,
    totals: {
      operations: operations.length,
      sitelinks: made.SITELINK,
      callouts: made.CALLOUT,
      structuredSnippets: made.STRUCTURED_SNIPPET,
      linkedAgain: relinked,
      unlinked: record.unlinked.length,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney: [],
    skipped,
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type },
      links: [...linkedNow.keys()].sort(),
      texts: live.linked.map((a) => sameKey(a.fieldType, a)).sort(),
      assets: live.assets.filter((a) => asked.includes(a.assetId)).map((a) => ({ assetId: a.assetId, type: a.type })).sort((x, y) => x.assetId.localeCompare(y.assetId)),
    },
    before: { campaignId: campaign.campaignId, links: record.unlinked } satisfies AssetsChangeBefore,
    after: record,
  }
}

/** The record of a run, with the id Google gave each new asset (`assetResult` of the operation that made it). */
export function assetsRecordAfterRun(after: AssetsChangeRecord, responses: GoogleMutateResponse[]): AssetsChangeRecord {
  const idAt = (index: number): string | null => {
    const name = responses[index]?.assetResult?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : null
  }
  return {
    ...after,
    linked: after.linked.map((l) => ({ ...l, assetId: l.assetId.startsWith(OP) ? idAt(Number(l.assetId.slice(OP.length))) ?? l.assetId : l.assetId })),
    unlinked: after.unlinked.map((l) => ({ ...l })),
  }
}
