#!/usr/bin/env python3
from __future__ import annotations
import csv, hashlib, json
from pathlib import Path
from datetime import datetime, timezone
import argparse

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--queue',default='data_openalex_queue.csv'); ap.add_argument('--results-dir',default='data/openalex/results'); ap.add_argument('--public-dir',default='docs/data/openalex'); args=ap.parse_args()
    out=Path(args.public_dir); out.mkdir(parents=True,exist_ok=True)
    shards={}; completed=not_found=errors=0
    for path in Path(args.results_dir).glob('batch_*.jsonl'):
        for line in path.read_text(encoding='utf8').splitlines():
            if not line.strip(): continue
            r=json.loads(line); sh=hashlib.sha1(r['journal_id'].encode()).hexdigest()[:2]
            shards.setdefault(sh,{})[r['journal_id']]=r
            if r.get('status')=='completed': completed+=1
            elif r.get('status')=='not_found': not_found+=1
            else: errors+=1
    for old in out.glob('??.json'): old.unlink()
    for sh,rows in shards.items():
        (out/f'{sh}.json').write_text(json.dumps(rows,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    with open(args.queue,encoding='utf8',newline='') as f: queue=list(csv.DictReader(f))
    counts={}
    for r in queue: counts[r.get('status','pending')]=counts.get(r.get('status','pending'),0)+1
    status={'version':'0.8','completed':counts.get('completed',0),'pending':counts.get('pending',0),'not_found':counts.get('not_found',0),'ambiguous':counts.get('ambiguous',0),'errors':counts.get('error',0),'last_update':datetime.now(timezone.utc).isoformat()}
    (out/'status.json').write_text(json.dumps(status,ensure_ascii=False,indent=2),encoding='utf8')
    print(status)
if __name__=='__main__': main()
