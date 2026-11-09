/**
 * The mail that brings a rider the measurement link (B-W2b-171): in the rider's language (Italian or English), naming the
 * sender and the garment, what it takes, until when the link works; never the measurements. The link itself is added
 * after the commit (the token is never stored).
 */
export type MeasureMailLocale = 'it' | 'en'

export const MEASURE_MAIL_TEMPLATE = 'sales.measure_link'

const day = (date: Date, locale: MeasureMailLocale): string => {
  const iso = date.toISOString().slice(0, 10)
  return locale === 'it' ? iso.split('-').reverse().join('/') : iso
}

export function measureMail(locale: MeasureMailLocale, input: { readonly companyName: string; readonly riderName: string; readonly garment: string; readonly expiresAt: Date; readonly photos: boolean }, url: string) {
  const until = day(input.expiresAt, locale)
  if (locale === 'it') {
    return {
      subject: `Le misure per ${input.garment} — ${input.companyName}`,
      body: [
        `Buongiorno ${input.riderName},`,
        '',
        `per realizzare ${input.garment} su misura ci servono le sue misure${input.photos ? ' e tre foto (davanti, di lato, dietro) con un indumento aderente' : ''}. Ci vogliono circa 15 minuti, un metro da sarta e una persona che aiuti.`,
        'Prima di ogni campo trova come usiamo i suoi dati.',
        url,
        '',
        `Il link vale fino al ${until} ed è solo per lei: non lo inoltri. Può fermarsi e riprendere da qui: conserviamo noi la bozza.`,
      ].join('\n'),
    }
  }
  return {
    subject: `Your measurements for ${input.garment} — ${input.companyName}`,
    body: [
      `Hello ${input.riderName},`,
      '',
      `To make ${input.garment} to measure we need your measurements${input.photos ? ' and three photos (front, side, back) in a base layer' : ''}. It takes about 15 minutes, a soft tape measure and someone to help.`,
      'Before any field you will find how we use your data.',
      url,
      '',
      `The link works until ${until} and is for you only: please do not forward it. You can stop and finish later from it: we keep the draft.`,
    ].join('\n'),
  }
}
