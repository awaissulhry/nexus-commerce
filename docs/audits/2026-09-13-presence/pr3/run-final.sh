#!/bin/zsh
set -u
cd /Users/awais/nexus-commerce/apps/api
uptime
node -e 'if(require("os").loadavg()[0]>8)process.exit(75)'
if [ $? -ne 0 ]; then exit 75; fi
node ../../scripts/_vtf-env-which-db.mjs
../../node_modules/.bin/tsc --noEmit -p tsconfig.json --tsBuildInfoFile /private/tmp/nexus-pr3-presence/api-final.tsbuildinfo > /private/tmp/nexus-pr3-presence/api-final-tsc.log 2>&1
pr3_tsc=$?
echo TSC_EXIT=$pr3_tsc
uptime
node -e 'if(require("os").loadavg()[0]>8)process.exit(75)'
if [ $? -ne 0 ]; then exit 75; fi
PR3_LOCAL_DB_TESTS=1 ../../node_modules/.bin/vitest run --maxWorkers=2 --reporter=verbose src/lib/listing-coordinate.vitest.test.ts src/lib/listing-coordinate.local.vitest.test.ts src/lib/listing-coordinate-sites.local.vitest.test.ts src/services/amazon-market-offer.presence.vitest.test.ts src/services/amazon-mapper.presence.vitest.test.ts src/services/amazon/amazon-flat-file-remove.service.vitest.test.ts src/services/ebay-flat-file-delete.service.vitest.test.ts src/services/follow-master.vitest.test.ts src/services/follow-master.bulk.vitest.test.ts src/routes/marketplaces.presence.vitest.test.ts src/services/outbound-sync.vitest.test.ts src/services/ebay-trading-api.market.vitest.test.ts src/services/ebay-label-guard.presence.vitest.test.ts > /private/tmp/nexus-pr3-presence/api-final-vitest.log 2>&1
pr3_test=$?
echo VITEST_EXIT=$pr3_test
uptime
node -e 'if(require("os").loadavg()[0]>8)process.exit(75)'
if [ $? -ne 0 ]; then exit 75; fi
node ../../scripts/check-route-prisma-ratchet.mjs --check > /private/tmp/nexus-pr3-presence/api-final-route-prisma.log 2>&1
pr3_route=$?
echo ROUTE_PRISMA_EXIT=$pr3_route
echo "PR3_FINAL tsc=$pr3_tsc vitest=$pr3_test route_prisma=$pr3_route"
if [ $pr3_tsc -ne 0 ] || [ $pr3_test -ne 0 ]; then exit 1; fi
