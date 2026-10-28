# primitives/icons/

**Icon convention.** [`lucide-react`](https://lucide.dev) is the default icon set
across the platform — import directly where needed:

```tsx
import { Search, ChevronDown } from 'lucide-react'
```

Use a consistent `size` (15–16px in dense UI) and let color inherit
(`currentColor`) so icons pick up the surrounding token color.

**Custom SVGs** that have no Lucide equivalent live here. The 8 campaign-builder
glyphs (`_shell/builder-icons.tsx` — Atom/Rocket/Cubes/…) are ads-specific and
are lifted into this folder during the `ads.css` migration (Phase 9), when ads
starts consuming the DS — kept out of the generic primitive set until then.
