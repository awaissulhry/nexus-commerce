from pathlib import Path
from datetime import datetime, timezone
import hashlib,json,difflib,subprocess
root=Path.cwd();here=root/'docs/audits/2026-09-12-language-axis/step5'
sha=lambda b:hashlib.sha256(b).hexdigest()
before=json.loads((here/'before.json').read_text());scope=json.loads((here/'scope.json').read_text());manifest=[];diff=[]
for file in scope:
 p=root/file;old=before.get(file,{}).get('content','');now=p.read_text() if p.exists() else ''
 if now==old:continue
 manifest.append({'file':file,'mtime':datetime.fromtimestamp(p.stat().st_mtime,timezone.utc).isoformat() if p.exists() else None,'sha256':sha(p.read_bytes()) if p.exists() else None,'beforeSha256':before.get(file,{}).get('sha256'),'kind':'changed' if file in before else 'new'})
 diff.extend(difflib.unified_diff(old.splitlines(True),now.splitlines(True),fromfile='before-step5/'+file,tofile='after-step5/'+file))
(here/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(here/'step5-source.diff').write_text(''.join(diff))
prior=json.loads((here.parent/'step4/protected-check.json').read_text());protected=[]
for row in prior['files']:
 current=sha((root/row['file']).read_bytes());protected.append({'file':row['file'],'before':row['after'],'after':current,'unchanged':row['after']==current})
(here/'protected-check.json').write_text(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'baseline':'Step 4 closing receipt '+prior['at'],'files':protected},indent=2)+'\n')
assert all(p['unchanged'] for p in protected if '/services/amazon/flat-file' in p['file'] or 'amazon-batch-feed.service.ts' in p['file'])
check=subprocess.run(['git','diff','--check','--',*scope],capture_output=True,text=True)
(here/'diff-check.json').write_text(json.dumps({'at':datetime.now(timezone.utc).isoformat(),'exitCode':check.returncode,'output':check.stdout+check.stderr},indent=2)+'\n')
print(json.dumps({'changedFiles':len(manifest),'diffCheck':check.returncode,'protected':len(protected),'protectedChanged':[p['file'] for p in protected if not p['unchanged']]}))
