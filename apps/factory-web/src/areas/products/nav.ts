import { Shirt } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Products (A2 §1.3 row 3; design 01 §3.3 "Products / Prodotti"): what we make — styles with colours × sizes, their
 * BOM, routing, cost and compliance in one studio, and the libraries they draw from. Labels are message keys
 * (`shell:` = messages/<locale>/shell.json). B-W1-11/13/14/16/20 part 2 build Styles (SCR-040 … SCR-045); Materials and
 * the libraries (Operations, Sizes & measurements) join with their own steps.
 */
export const officeArea: OfficeAreaNav = {
  order: 3,
  area: {
    id: 'products',
    label: 'shell:nav.products.area',
    href: '/products',
    icon: Shirt,
    phone: 'more',
    sections: [
      {
        id: 'products-main',
        label: 'shell:nav.products.main',
        hideLabel: true,
        noCrumb: true,
        items: [
          // SCR-040 … SCR-045: styles, their colourways and SKUs, BOM, routing, cost and compliance (product.styles.view).
          { id: 'products-styles', label: 'shell:nav.products.styles', href: '/products/styles', icon: Shirt, permission: 'product.styles.view' },
        ],
      },
    ],
  },
}
