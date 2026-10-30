import { Clock, Layers, Ruler, Shirt } from 'lucide-react'
import type { OfficeAreaNav } from '../../shell/nav/office-nav'

/**
 * Products (design 01 area 3 "Products / Prodotti"): what we make — styles with colours × sizes, their
 * BOM, routing, cost and compliance in one studio, and the libraries they draw from. Labels are message keys
 * (`shell:` = messages/<locale>/shell.json). B-W1-11/13/14/16/20 part 2 build Styles (SCR-040 … SCR-045); the product
 * screens step builds Materials & trims (SCR-047/048) and the libraries Operations and Sizes & measurements (SCR-049),
 * in the approved tree's order (01-navigation-tree: Main › Styles, Materials & trims; Libraries › Operations, Sizes).
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
          // SCR-047/048: leather, textiles, trims, protectors and labels with units, colours, supplier and standard cost.
          { id: 'products-materials', label: 'shell:nav.products.materials', href: '/products/materials', icon: Layers, permission: 'product.materials.view' },
        ],
      },
      {
        id: 'products-libraries',
        label: 'shell:nav.products.libraries',
        items: [
          // SCR-049: the operation library with standard minutes and machines (reading it is product.routing.view).
          { id: 'products-operations', label: 'shell:nav.products.operations', href: '/products/operations', icon: Clock, permission: 'product.routing.view' },
          // SCR-049: size scales with each size's body measures (the size scale routes read with product.styles.view).
          { id: 'products-sizes', label: 'shell:nav.products.sizes', href: '/products/sizes', icon: Ruler, permission: 'product.styles.view' },
        ],
      },
    ],
  },
}
