// Populate eBay IT flat-file rows for the Gale Jacket family
// Source: Amazon IT platform data, mapped to eBay channel listing fields
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

const p = new PrismaClient()

const PARENT_ID = 'cmokmy3a40078pm0p1fvnu523'
const CATEGORY_ID = '177104'
const CATEGORY_NAME = 'Giacche e giubbotti'
const CATEGORY_PATH = 'Auto e moto: ricambi e accessori › Abbigliamento, caschi e protezioni › Abbigliamento per moto › Giacche e giubbotti'

const TITLE = 'XAVIA GALE Giacca da Moto Uomo Impermeabile CE Livello 2 Protezioni Incluse'

const BULLETS = [
  "PROTEZIONE: Protezioni Per Gomiti, Spalle E Schiena Garantiscono Una Resistenza Agli Urti Superiore, Con Imbottitura Aggiuntiva Sull'addome E Sulla Schiena.",
  "VENTILAZIONE E FLESSIBILITÀ MIGLIORATE: Le Cerniere Di Ventilazione Posizionate Strategicamente Sul Petto E Sulla Schiena Migliorano Il Flusso D'aria, Mentre I Pannelli Elasticizzati Sotto Le Braccia E I Gomiti Offrono Libertà Di Movimento.",
  "IMPERMEABILE: Progettato Per Una Protezione Completamente Impermeabile Contro Pioggia E Umidità, Ideale Per Varie Condizioni Atmosferiche.",
  "ALTA VISIBILITÀ: I Pannelli Riflettenti Aumentano La Visibilità In Condizioni Di Scarsa Illuminazione Per La Sicurezza.",
  "VESTIBILITÀ PERSONALIZZABILE: Le Linguette Regolabili Sui Bicipiti E Le Regolazioni In Velcro Su Vita, Polsi E Colletto Garantiscono Una Vestibilità Su Misura.",
]

const FULL_DESCRIPTION = `Scopri comfort e protezione senza precedenti con la giacca da moto Gale, realizzata meticolosamente per i motociclisti che danno priorità alla sicurezza e alle prestazioni su strada. Questa giacca combina una robusta struttura impermeabile con caratteristiche protettive avanzate, tra cui protezioni per gomiti, spalle e schiena, garantendo resistenza agli urti e sicurezza superiori durante ogni corsa. Progettata per versatilità e durata, la giacca Gale è dotata di imbottitura aggiuntiva sull'addome e sulla schiena per una maggiore protezione nelle aree critiche. Le cerniere di ventilazione posizionate strategicamente sul petto e sulla schiena forniscono un flusso d'aria ottimale, mantenendoti fresco e comodo durante le lunghe pedalate in condizioni meteorologiche variabili. I pannelli elasticizzati sotto le braccia e i gomiti offrono flessibilità e libertà di movimento, ottimizzando il comfort. I pannelli riflettenti su tutta la giacca aumentano la visibilità in condizioni di scarsa illuminazione, migliorando la sicurezza durante le corse notturne o in condizioni meteorologiche avverse. Le linguette regolabili sui bicipiti e le regolazioni in velcro su vita, polsi e colletto offrono una vestibilità personalizzata, garantendo comfort e funzionalità. Che si tratti di navigare per le strade cittadine o di intraprendere avventure attraverso il paese, la giacca da moto Gale offre prestazioni e stile senza compromessi per i motociclisti che cercano affidabilità in tutte le condizioni di guida.`

function buildDescription() {
  const bulletHtml = BULLETS.map(b => `  <li>${b}</li>`).join('\n')
  return `<div>\n<ul>\n${bulletHtml}\n</ul>\n<p>${FULL_DESCRIPTION}</p>\n</div>`
}

const BLACK_IMAGES = [
  'https://m.media-amazon.com/images/I/719YfFDNBOL.jpg',
  'https://m.media-amazon.com/images/I/91H1cawzU6L.jpg',
  'https://m.media-amazon.com/images/I/91IAKoHCQtL.jpg',
  'https://m.media-amazon.com/images/I/711EFrb6VAL.jpg',
  'https://m.media-amazon.com/images/I/91mwV7ACzRL.jpg',
  'https://m.media-amazon.com/images/I/A1WgzcXIPUL.jpg',
  'https://m.media-amazon.com/images/I/91x4vzVKTZL.jpg',
]

const YELLOW_IMAGES = [
  'https://m.media-amazon.com/images/I/811HWZOl7TL.jpg',
  'https://m.media-amazon.com/images/I/41rem1s06zL.jpg',
  'https://m.media-amazon.com/images/I/91aisNPM6aL.jpg',
  'https://m.media-amazon.com/images/I/51Xx821TH9L.jpg',
  'https://m.media-amazon.com/images/I/711EFrb6VAL.jpg',
  'https://m.media-amazon.com/images/I/91+TNBtqhhL.jpg',
  'https://m.media-amazon.com/images/I/51oje-4VmjL.jpg',
  'https://m.media-amazon.com/images/I/91dS7JyR-BL.jpg',
]

const CHILDREN = [
  { id: 'cmokmy0jf0003pm0ppnu1b2yy', sku: 'GALE-JACKET-BLACK-MEN-3XL',  color: 'Nero',   size: '3XL', stock: 38 },
  { id: 'cmokmy0jt0004pm0p0gaufo1b', sku: 'GALE-JACKET-BLACK-MEN-4XL',  color: 'Nero',   size: '4XL', stock: 14 },
  { id: 'cmokmy2ir005bpm0p0sm1rxx8', sku: 'GALE-JACKET-BLACK-MEN-5XL',  color: 'Nero',   size: '5XL', stock: 0  },
  { id: 'cmokmy0k70005pm0puvz2ucxu', sku: 'GALE-JACKET-BLACK-MEN-L',    color: 'Nero',   size: 'L',   stock: 108},
  { id: 'cmokmy0kl0006pm0p9auaundx', sku: 'GALE-JACKET-BLACK-MEN-M',    color: 'Nero',   size: 'M',   stock: 134},
  { id: 'cmokmy0ky0007pm0p3vj7q0mh', sku: 'GALE-JACKET-BLACK-MEN-S',   color: 'Nero',   size: 'S',   stock: 2  },
  { id: 'cmokmy0lc0008pm0p2thzmlqq', sku: 'GALE-JACKET-BLACK-MEN-XL',  color: 'Nero',   size: 'XL',  stock: 91 },
  { id: 'cmokmy0lr0009pm0p9yxk7ho0', sku: 'GALE-JACKET-BLACK-MEN-XS',  color: 'Nero',   size: 'XS',  stock: 18 },
  { id: 'cmokmy0m9000apm0pm52rd77m', sku: 'GALE-JACKET-BLACK-MEN-XXL', color: 'Nero',   size: 'XXL', stock: 24 },
  { id: 'cmokmy0n4000cpm0ptkjitr0f', sku: 'GALE-JACKET-YELLOW-MEN-3XL', color: 'Giallo', size: '3XL', stock: 0 },
  { id: 'cmokmy0ni000dpm0p2xvcpkma', sku: 'GALE-JACKET-YELLOW-MEN-4XL', color: 'Giallo', size: '4XL', stock: 22},
  { id: 'cmokmy0o1000epm0pca79fbbf', sku: 'GALE-JACKET-YELLOW-MEN-5XL', color: 'Giallo', size: '5XL', stock: 0 },
  { id: 'cmokmy0og000fpm0pdwckcnq0', sku: 'GALE-JACKET-YELLOW-MEN-L',   color: 'Giallo', size: 'L',   stock: 77},
  { id: 'cmokmy0ot000gpm0p4z5vwnoo', sku: 'GALE-JACKET-YELLOW-MEN-M',   color: 'Giallo', size: 'M',   stock: 21},
  { id: 'cmokmy0p6000hpm0ptee51htd', sku: 'GALE-JACKET-YELLOW-MEN-S',   color: 'Giallo', size: 'S',   stock: 16},
  { id: 'cmokmy0pk000ipm0pi8nl7pbn', sku: 'GALE-JACKET-YELLOW-MEN-XL',  color: 'Giallo', size: 'XL',  stock: 56},
  { id: 'cmokmy0py000jpm0pc2jcd5ul', sku: 'GALE-JACKET-YELLOW-MEN-XS',  color: 'Giallo', size: 'XS',  stock: 16},
  { id: 'cmokmy0qb000kpm0p06pmx2vt', sku: 'GALE-JACKET-YELLOW-MEN-XXL', color: 'Giallo', size: 'XXL', stock: 34},
]

const BASE_PLATFORM = {
  categoryId: CATEGORY_ID,
  categoryName: CATEGORY_NAME,
  categoryPath: CATEGORY_PATH,
  conditionId: 'NEW',
  handlingTime: 3,
  bestOffer: false,
  bestOfferFloor: 0,
  bestOfferCeiling: 0,
  vatRate: '22',
  listingFormat: 'FIXED_PRICE',
  listingDuration: 'GTC',
  itemLocationCountry: 'IT',
  packageWeight: 2,
  weightUnit: 'KILOGRAM',
  packageLength: 45,
  packageWidth: 30,
  packageHeight: 8,
  dimensionUnit: 'CENTIMETER',
}

async function main() {
  const description = buildDescription()
  console.log('Title length:', TITLE.length, 'chars (eBay IT limit: 80)')

  // 1. Update parent listing (already exists)
  const parentResult = await p.channelListing.updateMany({
    where: { productId: PARENT_ID, channel: 'EBAY', marketplace: 'IT' },
    data: {
      title: TITLE,
      description,
      listingStatus: 'DRAFT',
      fulfillmentMethod: 'FBM',
      variationTheme: 'Color,Size',
      platformAttributes: {
        ...BASE_PLATFORM,
        imageUrls: [...BLACK_IMAGES, ...YELLOW_IMAGES].slice(0, 12),
        itemSpecifics: {
          'Brand': 'XAVIA',
          'Materiale': 'Poliestere, Nylon',
          'Genere': 'Uomo',
          'Stagione': 'Tutte le stagioni',
          'Tipo di giacca': 'Da moto',
          'Paese di fabbricazione': 'Pakistan',
          'Livello di protezione': 'CE Livello 2',
        },
        _axisNameLabels: {},
        _axisValueLabels: {},
        _categoryHistory: [],
        _versionHistory: [],
      },
    },
  })
  console.log(`PARENT updated (${parentResult.count} row)`)

  // 2. Upsert all 18 children for IT marketplace
  let created = 0, updated = 0
  for (const child of CHILDREN) {
    const images = child.color === 'Nero' ? BLACK_IMAGES : YELLOW_IMAGES
    const platformAttributes = {
      ...BASE_PLATFORM,
      imageUrls: images,
      itemSpecifics: {
        'Brand': 'XAVIA',
        'Colore': child.color,
        'Taglia': child.size,
        'Materiale': 'Poliestere, Nylon',
        'Genere': 'Uomo',
        'Stagione': 'Tutte le stagioni',
        'Tipo di giacca': 'Da moto',
        'Paese di fabbricazione': 'Pakistan',
        'Livello di protezione': 'CE Livello 2',
      },
    }

    const existing = await p.channelListing.findFirst({
      where: { productId: child.id, channel: 'EBAY', marketplace: 'IT' },
      select: { id: true },
    })

    if (existing) {
      await p.channelListing.update({
        where: { id: existing.id },
        data: {
          title: TITLE,
          description,
          price: 105,
          quantity: child.stock,
          fulfillmentMethod: 'FBM',
          variationTheme: 'Color,Size',
          platformAttributes,
        },
      })
      updated++
    } else {
      await p.channelListing.create({
        data: {
          productId: child.id,
          channelMarket: 'EBAY_IT',
          channel: 'EBAY',
          region: 'IT',
          marketplace: 'IT',
          title: TITLE,
          description,
          listingStatus: 'DRAFT',
          fulfillmentMethod: 'FBM',
          price: 105,
          quantity: child.stock,
          variationTheme: 'Color,Size',
          platformAttributes,
        },
      })
      created++
    }
    console.log(`  ${child.sku.padEnd(30)} ${child.color.padEnd(7)} ${child.size.padEnd(4)} stock=${String(child.stock).padStart(3)} ✓`)
  }

  console.log(`\nDone — ${created} created, ${updated} updated for EBAY IT`)
  await p.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
