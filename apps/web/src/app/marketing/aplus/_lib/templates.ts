// MC.8.7 — curated A+ Content templates.
//
// Hardcoded for now; operator-editable templates land in a follow-up
// commit (would need a SavedAPlusTemplate Prisma model). The current
// catalog is anchored on Xavia Racing's motorcycle-gear taxonomy:
// jackets, helmets, gloves, pants. Each template seeds a complete
// document — operator just edits copy + swaps in their own assets
// after applying.
//
// The shape mirrors APlusModule rows so the bulk-apply endpoint can
// pass payload through unchanged.

export interface TemplateModule {
  type: string
  payload: Record<string, unknown>
}

export interface AplusTemplate {
  id: string
  label: string
  category: 'jacket' | 'helmet' | 'gloves' | 'pants' | 'general'
  description: string
  modules: TemplateModule[]
}

export const TEMPLATES: AplusTemplate[] = [
  {
    id: 'tpl_motorcycle_jacket',
    label: 'Motorcycle jacket — full',
    category: 'jacket',
    description:
      'Hero + 3 lifestyle panels + comparison vs older models + protection FAQ.',
    modules: [
      {
        type: 'image_header_with_text',
        payload: {
          headline: 'Built for the open road',
          subhead:
            'Premium motorcycle jackets engineered for rider comfort and certified protection.',
        },
      },
      {
        type: 'multiple_image_text_panels',
        payload: {
          panels: [
            {
              headline: 'CE-certified armor',
              body: 'Level 2 shoulder + elbow protectors, back protector pocket.',
            },
            {
              headline: 'All-weather shell',
              body: 'Waterproof outer with removable thermal liner — 0 °C to 30 °C usable range.',
            },
            {
              headline: 'Rider-tested fit',
              body: 'Pre-curved sleeves and articulated back panel for on-bike posture.',
            },
          ],
        },
      },
      {
        type: 'comparison_chart_3col',
        payload: {
          asins: [],
          attributes: [
            'CE armor level',
            'Waterproof rating',
            'Thermal liner',
            'Reflective panels',
            'Made in Italy',
          ],
        },
      },
      {
        type: 'faq',
        payload: {
          items: [
            {
              question: 'Is the armor included?',
              answer:
                'Yes — Level 2 CE-certified shoulder and elbow protectors are included. The back-protector pocket fits SAS-TEC or D3O Level 2 inserts (sold separately).',
            },
            {
              question: 'Can I wash the jacket?',
              answer:
                'The outer shell is hand-wash only. The thermal liner is machine washable on a cold gentle cycle.',
            },
            {
              question: 'How does sizing run?',
              answer:
                'Sized for armoured fit — most riders size up if between sizes. Refer to the size chart for chest + sleeve measurements.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'tpl_motorcycle_helmet',
    label: 'Motorcycle helmet — full',
    category: 'helmet',
    description:
      'Hero + safety standards comparison + 4-image features grid + FAQ.',
    modules: [
      {
        type: 'image_header_with_text',
        payload: {
          headline: 'Certified protection. Race-track DNA.',
          subhead:
            'ECE 22.06 + DOT-approved helmets with the comfort details that matter on long rides.',
        },
      },
      {
        type: 'image_gallery_4',
        payload: {
          images: [
            { alt: 'Profile' },
            { alt: 'Front' },
            { alt: 'Visor open' },
            { alt: 'Inner liner detail' },
          ],
        },
      },
      {
        type: 'comparison_chart_4col',
        payload: {
          asins: [],
          attributes: [
            'Safety standard',
            'Shell material',
            'Weight (g)',
            'Pinlock-ready visor',
            'Bluetooth-ready',
            'Made in Italy',
          ],
        },
      },
      {
        type: 'faq',
        payload: {
          items: [
            {
              question: 'Which safety standard does it meet?',
              answer: 'ECE 22.06 (Europe) and DOT FMVSS 218 (US).',
            },
            {
              question: 'Is the visor anti-fog?',
              answer:
                'The visor is Pinlock-ready; a Pinlock 70 insert is included with every helmet.',
            },
            {
              question: 'Can I install a comms unit?',
              answer:
                'Yes — pre-cut speaker pockets and a chin mic channel are built into the cheek pads.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'tpl_motorcycle_gloves',
    label: 'Motorcycle gloves — full',
    category: 'gloves',
    description:
      'Hero + 3 protection panels + bulleted feature list + FAQ.',
    modules: [
      {
        type: 'image_header_with_text',
        payload: {
          headline: 'Hands-on safety',
          subhead:
            'CE Level 1+ gloves with knuckle armor, palm sliders, and touch-screen-ready fingertips.',
        },
      },
      {
        type: 'multiple_image_text_panels',
        payload: {
          panels: [
            {
              headline: 'Knuckle armor',
              body: 'Hard-shell PU knuckles + secondary impact foam.',
            },
            {
              headline: 'Palm sliders',
              body: 'TPR sliders absorb low-side abrasion at scooter to track speeds.',
            },
            {
              headline: 'Touch-screen ready',
              body: 'Index + thumb tips work with phones and clusters without removing the glove.',
            },
          ],
        },
      },
      {
        type: 'bulleted_list_with_images',
        payload: {
          items: [
            { headline: 'Goatskin palm', body: 'Soft, durable, and abrasion-rated.' },
            { headline: 'Mesh-vented back', body: 'Stays cool in summer commutes.' },
            { headline: 'Visor wiper', body: 'Microfiber wiper on the left thumb.' },
            { headline: 'Pre-curved fingers', body: 'On-bar shape reduces fatigue on long rides.' },
          ],
        },
      },
      {
        type: 'faq',
        payload: {
          items: [
            {
              question: 'Are these waterproof?',
              answer:
                'Not fully — the leather palm is naturally water-resistant but extended rain will soak through. Pair with a waterproof overglove for wet commutes.',
            },
            {
              question: 'Touch-screen accuracy?',
              answer:
                'Conductive thread on index + thumb works with both capacitive screens and modern bike clusters.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'tpl_motorcycle_pants',
    label: 'Motorcycle pants — full',
    category: 'pants',
    description: 'Hero + sidebar feature list + lifestyle panels + FAQ.',
    modules: [
      {
        type: 'image_header_with_text',
        payload: {
          headline: 'Long-haul comfort, track-grade protection',
          subhead:
            'Hip + knee CE Level 2 armor + Cordura abrasion zones in a daily-rider cut.',
        },
      },
      {
        type: 'single_image_sidebar',
        payload: {
          sidebarHeadline: 'What you get',
          sidebarItems: [
            'Level 2 hip + knee armor',
            'Cordura abrasion panels',
            'Removable thermal liner',
            'Boot-zip + connection zip',
            'Reflective rear chevrons',
            'Made in Italy',
          ],
        },
      },
      {
        type: 'multiple_image_text_panels',
        payload: {
          panels: [
            {
              headline: 'Daily commute fit',
              body: 'Worn over jeans? Or cut as your daily commuter? Both work — adjustable waist + thigh.',
            },
            {
              headline: 'Hot/cold range',
              body: 'Mesh vents up the thigh + zip-out thermal liner cover commute conditions year-round.',
            },
            {
              headline: 'Boot-friendly',
              body: 'YKK boot-zip opens wide enough for most touring boots; connection zip pairs with our jackets.',
            },
          ],
        },
      },
      {
        type: 'faq',
        payload: {
          items: [
            {
              question: 'Do they connect to your jackets?',
              answer:
                'Yes — short connection zip on the rear waistband joins to any Xavia jacket with the matching zip.',
            },
            {
              question: 'Can I add hip armor?',
              answer:
                'Hip pockets fit Level 2 inserts (sold separately). Knee armor is included at Level 2.',
            },
          ],
        },
      },
    ],
  },
  {
    id: 'tpl_general_simple',
    label: 'General — simple A+',
    category: 'general',
    description: 'Hero + image-text-image + FAQ. Useful starting point.',
    modules: [
      {
        type: 'image_header_with_text',
        payload: {
          headline: 'Headline goes here',
          subhead: 'Sub-headline.',
        },
      },
      {
        type: 'standard_image_text',
        payload: {
          headline: 'Why customers choose us',
          body: 'Body copy here. Talk benefits, not features.',
        },
      },
      {
        type: 'faq',
        payload: {
          items: [
            { question: 'Question 1?', answer: 'Answer 1.' },
            { question: 'Question 2?', answer: 'Answer 2.' },
          ],
        },
      },
    ],
  },
]

export function getTemplate(id: string): AplusTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null
}
