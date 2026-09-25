#!/bin/bash
# Every spreadsheet in the corpus through the catalog page's "Amazon template" path (parse + map, no staging).
SP=/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad
FAM=cmtny43jv002jnjfbb6hnijqx
i=0
find /Users/awais/Desktop/2026/LISTNGS -type f \( -iname '*.xlsx' -o -iname '*.xlsm' \) ! -name '~$*' | sort | while read -r f; do
  i=$((i+1)); id=$(printf "all-%03d" $i)
  printf '%s\t%s\n' "$id" "${f#/Users/awais/Desktop/2026/LISTNGS/}" >> $SP/runs/out/all-index.tsv
  node $SP/runs/run.mjs "$(python3 -c 'import json,sys; print(json.dumps({"id":sys.argv[1],"path":"catalog-amazon","file":sys.argv[2],"market":"auto","account":"cmothu9bo0000nz01asw6wx8j","family":sys.argv[3],"mode":"upsert","stage":False}))' "$id" "$f" "$FAM")" 2>/dev/null | grep '^{"id"'
done
