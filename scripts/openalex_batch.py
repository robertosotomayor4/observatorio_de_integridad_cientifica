#!/usr/bin/env python3
"""Procesa un lote de revistas mediante la API de OpenAlex.

Indicadores iniciales y sencillos:
- vinculación de la fuente por ISSN;
- producción anual desde counts_by_year;
- ratio de producción 2025 / mediana 2020-2024;
- cantidad y tasa de trabajos marcados como retractados;
- distribución de tipos documentales 2020-2025.

OpenAlex es complementario: este script no altera la categoría pública.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, os, statistics, sys, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
import requests

API='https://api.openalex.org'

def norm_issn(value: str) -> str:
    x=''.join(c for c in str(value).upper() if c.isdigit() or c=='X')
    return f'{x[:4]}-{x[4:]}' if len(x)==8 else ''

def api_get(session: requests.Session, path: str, key: str, params: dict[str,Any]|None=None, retries: int=5) -> tuple[dict[str,Any],requests.Response]:
    p=dict(params or {}); p['api_key']=key
    url=f'{API}{path}'
    last=None
    for attempt in range(retries):
        try:
            r=session.get(url,params=p,timeout=45,allow_redirects=True)
            if r.status_code==200: return r.json(),r
            if r.status_code in (403,429) or r.status_code>=500:
                last=RuntimeError(f'{r.status_code}: {r.text[:200]}')
                time.sleep(min(30,2**attempt)); continue
            if r.status_code==404: raise FileNotFoundError(path)
            r.raise_for_status()
        except (requests.Timeout,requests.ConnectionError) as e:
            last=e; time.sleep(min(30,2**attempt))
    raise RuntimeError(f'OpenAlex request failed: {last}')

def rate_limit(session,key):
    data,_=api_get(session,'/rate-limit',key)
    return data.get('rate_limit',{})

def resolve_source(session,key,issns):
    """Resolve ISSNs conservatively.

    OpenAlex accepts an ISSN as the singleton source identifier. Multiple ISSNs
    may legitimately return the same source. If they return different source
    IDs, the record is left ambiguous rather than silently merged.
    """
    candidates=[]
    for raw in issns:
        issn=norm_issn(raw)
        if not issn:
            continue
        try:
            data,_=api_get(
                session,
                f'/sources/{issn}',
                key,
                {'select':'id,issn_l,issn,display_name,type,works_count,cited_by_count,counts_by_year,is_oa,is_in_doaj'}
            )
        except FileNotFoundError:
            continue
        if data.get('type')=='journal':
            candidates.append((issn,data))
    if not candidates:
        return 'not_found',None,None,[]
    unique={str(data.get('id')):(issn,data) for issn,data in candidates if data.get('id')}
    if len(unique)>1:
        audit=[{
            'matched_issn':issn,
            'openalex_source_id':str(data.get('id')).rsplit('/',1)[-1],
            'display_name':data.get('display_name'),
            'works_count':int(data.get('works_count') or 0)
        } for issn,data in unique.values()]
        return 'ambiguous',None,None,audit
    matched,source=next(iter(unique.values()))
    return 'matched',matched,source,[]

def production(source):
    counts={int(x['year']):int(x.get('works_count') or 0) for x in source.get('counts_by_year',[]) if x.get('year')}
    baseline=[counts[y] for y in range(2020,2025) if y in counts]
    med=float(statistics.median(baseline)) if len(baseline)>=3 else None
    current=counts.get(2025)
    ratio=current/med if med is not None and med>=20 and current is not None and current>=50 else None
    return counts,current,med,ratio

def work_count_query(session,key,source_id,extra_filter):
    filt=f'primary_location.source.id:{source_id}'
    if extra_filter: filt+=','+extra_filter
    data,_=api_get(session,'/works',key,{'filter':filt,'per_page':1,'select':'id'})
    return int(data.get('meta',{}).get('count') or 0)

def type_distribution(session,key,source_id):
    data,_=api_get(session,'/works',key,{
        'filter':f'primary_location.source.id:{source_id},from_publication_date:2020-01-01,to_publication_date:2025-12-31',
        'group_by':'type','per_page':100
    })
    return {str(x.get('key_display_name') or x.get('key')):int(x.get('count') or 0) for x in data.get('group_by',[])}

def load_results(path: Path):
    if not path.exists(): return {}
    out={}
    for line in path.read_text(encoding='utf8').splitlines():
        if line.strip():
            row=json.loads(line); out[row['journal_id']]=row
    return out

def save_results(path: Path, rows: dict):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    with tmp.open('w',encoding='utf8') as f:
        for jid in sorted(rows): f.write(json.dumps(rows[jid],ensure_ascii=False,separators=(',',':'))+'\n')
    tmp.replace(path)

def save_queue(path,rows,fieldnames):
    tmp=path.with_suffix('.tmp')
    with tmp.open('w',encoding='utf8',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fieldnames); w.writeheader(); w.writerows(rows)
    tmp.replace(path)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--queue',default='data_openalex_queue.csv')
    ap.add_argument('--results-dir',default='data/openalex/results')
    ap.add_argument('--batch-size',type=int,default=500)
    ap.add_argument('--min-remaining-usd',type=float,default=.02)
    args=ap.parse_args()
    key=os.environ.get('OPENALEX_API_KEY','').strip()
    if not key: raise SystemExit('OPENALEX_API_KEY is required')
    qpath=Path(args.queue); rdir=Path(args.results_dir)
    with qpath.open(encoding='utf8',newline='') as f:
        reader=csv.DictReader(f); fieldnames=reader.fieldnames or []; queue=list(reader)
    pending=[r for r in queue if r.get('status') in ('pending','error') and int(r.get('attempts') or 0)<4][:args.batch_size]
    if not pending:
        print('No pending journals.'); return
    session=requests.Session(); session.headers.update({'User-Agent':'Observatorio-Integridad-Cientifica/0.8'})
    rl=rate_limit(session,key)
    print('Daily remaining USD:',rl.get('daily_remaining_usd'),'prepaid:',rl.get('prepaid_remaining_usd'))
    processed=0
    by_batch={}
    for row in pending:
        try:
            if processed%25==0:
                rl=rate_limit(session,key)
                remaining=float(rl.get('daily_remaining_usd') or 0)+float(rl.get('prepaid_remaining_usd') or 0)
                if remaining<args.min_remaining_usd:
                    print('Stopping before budget exhaustion.'); break
            issn_list=[x for x in str(row.get('issns') or '').split(';') if x.strip()]
            resolution,matched,source,candidates=resolve_source(session,key,issn_list)
            now=datetime.now(timezone.utc).isoformat()
            row['attempts']=str(int(row.get('attempts') or 0)+1); row['last_attempt']=now
            if resolution=='not_found':
                row['status']='not_found'; row['error']='No journal source found by supplied ISSNs'
                result={'journal_id':row['journal_id'],'status':'not_found','retrieved_at':now,'message':'No se encontró una fuente OpenAlex por los ISSN disponibles.'}
            elif resolution=='ambiguous':
                row['status']='ambiguous'; row['error']='Multiple OpenAlex sources returned for supplied ISSNs'
                result={'journal_id':row['journal_id'],'status':'ambiguous','retrieved_at':now,'candidates':candidates,'message':'Los ISSN disponibles conducen a más de una fuente OpenAlex. Se requiere resolver la identidad antes de integrar datos.'}
            else:
                sid=str(source['id']).rsplit('/',1)[-1]
                counts,current,median,ratio=production(source)
                retracted=work_count_query(session,key,sid,'is_retracted:true')
                types=type_distribution(session,key,sid)
                works=int(source.get('works_count') or 0)
                result={
                    'journal_id':row['journal_id'],'status':'completed','openalex_source_id':sid,'matched_issn':matched,
                    'display_name':source.get('display_name'),'works_count':works,'cited_by_count':int(source.get('cited_by_count') or 0),
                    'production_2025':current,'baseline_median_2020_2024':median,'production_ratio':ratio,
                    'retracted_count':retracted,'retraction_rate':(retracted/works if works else None),
                    'type_distribution_2020_2025':types,'counts_by_year':counts,'is_oa':source.get('is_oa'),'is_in_doaj':source.get('is_in_doaj'),
                    'data_status':'sufficient_for_ratio' if ratio is not None else 'limited_for_ratio','retrieved_at':now
                }
                row['status']='completed'; row['openalex_source_id']=sid; row['matched_issn']=matched; row['error']=''
            batch=int(row.get('batch') or 0)
            if batch not in by_batch:
                path=rdir/f'batch_{batch:04d}.jsonl'; by_batch[batch]=(path,load_results(path))
            by_batch[batch][1][row['journal_id']]=result
            processed+=1
            if processed%25==0:
                for path,rows in by_batch.values(): save_results(path,rows)
                save_queue(qpath,queue,fieldnames)
                print('checkpoint',processed)
        except Exception as e:
            row['status']='error'; row['attempts']=str(int(row.get('attempts') or 0)+1); row['last_attempt']=datetime.now(timezone.utc).isoformat(); row['error']=str(e)[:500]
            print('ERROR',row['journal_id'],e,file=sys.stderr)
    for path,rows in by_batch.values(): save_results(path,rows)
    save_queue(qpath,queue,fieldnames)
    print('Processed',processed)
if __name__=='__main__': main()
