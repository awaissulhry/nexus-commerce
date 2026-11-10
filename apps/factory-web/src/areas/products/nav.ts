import { Clock, FlaskConical, Layers, Palette, Ruler, Shirt } from 'lucide-react'
// B-W2b-244: Changes & versions' row icon.
import { GitPullRequestArrow } from 'lucide-react'
// B-W2b-239: Settings › Product settings.
import { SlidersHorizontal } from 'lucide-react'
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
      // B-W2b-261: Development (design 01: Products › Development › Samples & prototypes, SCR-110; Changes & versions joins it).
      {
        id: 'products-development',
        label: 'shell:nav.products.development',
        items: [
          // SCR-110: proto, fit, salesman, pre-production and CE test sample rounds on one board (sales.samples.view).
          { id: 'products-samples', label: 'shell:nav.products.samples', href: '/products/samples', icon: FlaskConical, permission: 'sales.samples.view' },
          // B-W2b-244 SCR-117: change requests and orders, the SMV changes waiting, released versions (product.changes.view).
          { id: 'products-changes', label: 'shell:nav.products.changes', href: '/products/changes', icon: GitPullRequestArrow, permission: 'product.changes.view' },
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
          // B-W2b-247 SCR-118: the colour library and the private-label brands' branding sets (read with product.styles.view).
          { id: 'products-colours', label: 'shell:nav.products.colours', href: '/products/colours', icon: Palette, permission: 'product.styles.view' },
        ],
      },
      // B-W2b-239: Settings › Product settings (SCR-251; design 01: the area's last group). GET /product/settings reads with product.styles.view.
      {
        id: 'products-settings',
        label: 'shell:nav.products.settingsGroup',
        items: [{ id: 'products-settings-page', label: 'shell:nav.products.settings', href: '/products/settings', icon: SlidersHorizontal, permission: 'product.styles.view' }],
      },
    ],
  },
}
