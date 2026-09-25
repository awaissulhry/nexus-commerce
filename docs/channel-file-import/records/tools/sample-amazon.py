import json, subprocess
SP = '/private/tmp/claude-501/-Users-awais-nexus-commerce/860563e3-4083-4cae-95e2-45981fb48a2e/scratchpad'
L = '/Users/awais/Desktop/2026/LISTNGS/JACKETS/'
F = lambda fam, mk, name: f"{L}{fam}/{'Amazon' if fam=='Gale' else 'AMAZON'}/LISTINGS/{mk}/{name} {mk} - FINAL (upload this)/{name} {mk}.xlsm"
cases = [
  ('s01-gale-it', F('Gale','IT','GALE')), ('s02-gale-de', F('Gale','DE','GALE')), ('s03-gale-fr', F('Gale','FR','GALE')), ('s04-gale-es', F('Gale','ES','GALE')),
  ('s05-airmesh-it-partial', F('AIR MESH','IT','AIRMESH')), ('s06-aireon-it-coat-pants', F('AIREON','IT','AIREON')), ('s07-aireon-de-blank-full', F('AIREON','DE','AIREON')),
  ('s08-moss-de', L + 'Moss/Amazon/LISTINGS/DE/MOSS DE - FINAL (upload this)/MOSS DE.xlsm'), ('s09-misano-it', F('Misano','IT','MISANO')), ('s10-misano-de', F('Misano','DE','MISANO')),
  ('s11-regal-it', F('REGAL','IT','REGAL')), ('s12-waterproof-fr', F('WATERPROOF','FR','WATERPROOF')),
  ('s13-gale-fr-newtemplate-old', L + 'Gale/Amazon/FR/GALE FR NEW TEMPLATE.xlsm'), ('s14-airmesh-es-old', L + 'AIR MESH/AMAZON/ES/ES.xlsm'),
]
for id, f in cases:
  args = {'id': id, 'path': 'catalog-amazon', 'file': f, 'market': 'auto', 'account': 'cmothu9bo0000nz01asw6wx8j', 'family': 'cmtny43jv002jnjfbb6hnijqx', 'mode': 'upsert', 'stage': True}
  r = subprocess.run(['node', f'{SP}/runs/run.mjs', json.dumps(args)], capture_output=True, text=True, timeout=1500)
  print([l[:400] for l in r.stdout.splitlines() if l.startswith('{"id"')] or r.stderr[-600:], flush=True)
