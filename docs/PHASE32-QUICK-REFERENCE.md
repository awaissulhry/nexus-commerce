# Phase 32: Quick Reference Guide

## Component Files Created

### Frontend Components

| Component | Path | Purpose |
|-----------|------|---------|
| ListingHealth | `apps/web/src/components/catalog/ListingHealth.tsx` | Multi-channel readiness scoring |
| JobMonitor | `apps/web/src/components/monitoring/JobMonitor.tsx` | BullMQ queue monitoring |
| MasterCatalogSidebar | `apps/web/src/components/catalog/MasterCatalogSidebar.tsx` | Marketplace filters & stock alerts |
| StatusPill | `apps/web/src/components/shared/StatusPill.tsx` | Status indicator component |
| ActionButton | `apps/web/src/components/shared/ActionButton.tsx` | Color-coded action buttons |
| VariationMatrixTable | `apps/web/src/components/catalog/VariationMatrixTable.tsx` | Professional variation table |

### Backend Routes

| Route File | Path | Purpose |
|-----------|------|---------|
| Listing Health Routes | `apps/api/src/routes/listing-health.routes.ts` | Listing health & marketplace data |
| Job Monitor Routes | `apps/api/src/routes/job-monitor.routes.ts` | Queue monitoring endpoints |

## Component Usage Examples

### ListingHealth Widget
```tsx
import ListingHealth from "@/components/catalog/ListingHealth";

export default function ProductEditPage({ productId }) {
  return (
    <ListingHealth 
      productId={productId}
      onRefresh={() => console.log("Refreshed")}
    />
  );
}
```

### JobMonitor
```tsx
import JobMonitor from "@/components/monitoring/JobMonitor";

export default function MonitoringPage() {
  return (
    <JobMonitor 
      autoRefresh={true}
      refreshInterval={5000}
      maxJobs={20}
    />
  );
}
```

### MasterCatalogSidebar
```tsx
import MasterCatalogSidebar from "@/components/catalog/MasterCatalogSidebar";

export default function CatalogPage() {
  const [filters, setFilters] = useState({
    marketplaces: [],
    stockAlerts: [],
    searchTerm: ""
  });

  return (
    <MasterCatalogSidebar onFilterChange={setFilters} />
  );
}
```

### StatusPill
```tsx
import StatusPill from "@/components/shared/StatusPill";

// Success status
<StatusPill status="success" label="Synced" size="md" />

// Warning status
<StatusPill status="warning" label="Pending" size="sm" />

// Error status
<StatusPill status="error" label="Failed" size="lg" />
```

### ActionButton
```tsx
import ActionButton from "@/components/shared/ActionButton";
import { Zap } from "lucide-react";

// Sync button (Nexus Blue)
<ActionButton variant="sync" icon={<Zap />}>
  Sync All Channels
</ActionButton>

// Master update button (Gold)
<ActionButton variant="master">
  Update Master Data
</ActionButton>

// Danger button
<ActionButton variant="danger" onClick={handleDelete}>
  Delete
</ActionButton>
```

### VariationMatrixTable
```tsx
import VariationMatrixTable from "@/components/catalog/VariationMatrixTable";

<VariationMatrixTable
  variations={variations}
  onEdit={(variation) => console.log("Edit", variation)}
  onDelete={(id) => console.log("Delete", id)}
  onDuplicate={(variation) => console.log("Duplicate", variation)}
  onSync={(id) => console.log("Sync", id)}
  loading={false}
/>
```

## API Endpoints

### Listing Health
```
GET /api/catalog/:productId/listing-health
GET /api/catalog/marketplace-presence
GET /api/catalog/stock-alerts
```

### Job Monitoring
```
GET /api/monitoring/queue-stats
GET /api/monitoring/jobs?limit=20&status=active
POST /api/monitoring/jobs/:jobId/retry
POST /api/monitoring/jobs/:jobId/cancel
POST /api/monitoring/queue/pause
POST /api/monitoring/queue/resume
GET /api/monitoring/queue/stats/detailed
```

## Color System

### Button Variants
- **Sync** (Nexus Blue): `#2563EB` - For sync operations
- **Master** (Gold): `#D97706` - For master data updates
- **Primary** (Indigo): `#4F46E5` - Primary actions
- **Secondary** (Slate): `#E2E8F0` - Secondary actions
- **Danger** (Red): `#DC2626` - Destructive actions

### Status Colors
- **Success**: `#10B981` (Green) ✓
- **Warning**: `#F59E0B` (Amber) ⚠
- **Error**: `#EF4444` (Red) ✗
- **Info**: `#3B82F6` (Blue) ℹ
- **Pending**: `#6B7280` (Gray) ⏳
- **Processing**: `#A855F7` (Purple) ⚙

## Key Features

### ListingHealth
- ✅ 6-field validation per channel
- ✅ Readiness score calculation (0-100%)
- ✅ Status indicators (ready/warning/critical)
- ✅ Expandable missing fields list
- ✅ Real-time refresh

### JobMonitor
- ✅ Live queue statistics
- ✅ Job status filtering
- ✅ Progress bars for active jobs
- ✅ Retry/cancel actions
- ✅ Auto-refresh capability
- ✅ Bulk job selection

### MasterCatalogSidebar
- ✅ Marketplace presence filters
- ✅ Stock alert filters (low/out-of-stock)
- ✅ Product search
- ✅ Quick action buttons
- ✅ Collapsible sections

### StatusPill
- ✅ 6 status variants
- ✅ 3 size options
- ✅ Automatic icons
- ✅ Smooth animations

### ActionButton
- ✅ 5 semantic variants
- ✅ 3 size options
- ✅ Loading state
- ✅ Icon support
- ✅ Full-width option

### VariationMatrixTable
- ✅ Sortable columns
- ✅ Multi-row selection
- ✅ Expandable details
- ✅ Bulk actions
- ✅ Status indicators
- ✅ Responsive design

## Integration Checklist

- [ ] Register listing health routes in API
- [ ] Register job monitor routes in API
- [ ] Import components in pages
- [ ] Test all API endpoints
- [ ] Verify database queries work
- [ ] Test responsive design
- [ ] Check accessibility (ARIA labels)
- [ ] Verify error handling
- [ ] Test loading states
- [ ] Performance testing

## Common Issues & Solutions

### ListingHealth not loading
**Problem**: Component shows loading spinner indefinitely
**Solution**: 
- Check product ID is valid
- Verify API endpoint is registered
- Check browser console for errors
- Ensure product exists in database

### JobMonitor showing no jobs
**Problem**: Queue stats show 0 jobs
**Solution**:
- Verify Redis is running
- Check queue is not paused
- Ensure jobs are being added
- Check queue name matches

### Filters not applying
**Problem**: MasterCatalogSidebar filters don't filter results
**Solution**:
- Verify onFilterChange callback is implemented
- Check filter state is being passed to parent
- Ensure API returns correct data
- Test filter logic in parent component

### Buttons not responding
**Problem**: ActionButton clicks don't trigger
**Solution**:
- Check onClick handler is provided
- Verify button is not disabled
- Check for JavaScript errors
- Test with console.log in handler

## Performance Tips

1. **Memoize components** if rendering frequently
2. **Debounce search** in MasterCatalogSidebar
3. **Paginate job results** with limit parameter
4. **Use React.lazy** for heavy components
5. **Optimize database queries** with indexes

## Testing Commands

```bash
# Test API endpoints
curl http://localhost:3000/api/catalog/marketplace-presence
curl http://localhost:3000/api/monitoring/queue-stats

# Test component rendering
npm run dev  # Start dev server
# Navigate to pages using components

# Run tests
npm test
```

## Documentation Files

- `docs/PHASE32-UX-POLISH-SUITE.md` - Complete documentation
- `docs/PHASE32-QUICK-REFERENCE.md` - This file

## Next Steps

1. **Register routes** in main API file
2. **Import components** in pages
3. **Test all endpoints** with curl/Postman
4. **Verify UI rendering** in browser
5. **Performance test** with multiple jobs
6. **User acceptance testing** with team

## Support

For issues or questions:
1. Check the full documentation in `PHASE32-UX-POLISH-SUITE.md`
2. Review component prop types in source files
3. Check API response formats in route files
4. Test with browser DevTools

---

**Phase 32 Status**: ✅ Complete
**Last Updated**: 2026-04-27
