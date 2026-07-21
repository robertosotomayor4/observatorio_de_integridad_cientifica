#!/usr/bin/env python3
"""Importa los resultados descargados por GitHub Actions a la SQLite maestra v0.8.

Uso local:
  python scripts/import_openalex_to_sqlite.py \
      --database observatorio_revistas_v0_8.sqlite \
      --results-dir data/openalex/results \
      --queue data_openalex_queue.csv
"""
from __future__ import annotations
import argparse, csv, json, sqlite3
from pathlib import Path


def iter_results(results_dir: Path):
    for path in sorted(results_dir.glob('batch_*.jsonl')):
        for line in path.read_text(encoding='utf-8').splitlines():
            if line.strip():
                yield path.name, json.loads(line)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--database',required=True)
    ap.add_argument('--results-dir',default='data/openalex/results')
    ap.add_argument('--queue',default='data_openalex_queue.csv')
    args=ap.parse_args()
    con=sqlite3.connect(args.database)
    con.execute('PRAGMA foreign_keys=OFF')
    completed=ambiguous=other=0
    with con:
        for source_file,r in iter_results(Path(args.results_dir)):
            status=r.get('status') or 'error'
            if status=='completed':
                con.execute('''INSERT INTO openalex_results_v08(
                    journal_id,status,openalex_source_id,matched_issn,openalex_display_name,
                    production_2025,baseline_median_2020_2024,production_ratio,works_count,cited_by_count,
                    retracted_count,retraction_rate,counts_by_year_json,type_distribution_json,retrieved_at,source_file
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(journal_id) DO UPDATE SET
                    status=excluded.status,openalex_source_id=excluded.openalex_source_id,
                    matched_issn=excluded.matched_issn,openalex_display_name=excluded.openalex_display_name,
                    production_2025=excluded.production_2025,baseline_median_2020_2024=excluded.baseline_median_2020_2024,
                    production_ratio=excluded.production_ratio,works_count=excluded.works_count,cited_by_count=excluded.cited_by_count,
                    retracted_count=excluded.retracted_count,retraction_rate=excluded.retraction_rate,
                    counts_by_year_json=excluded.counts_by_year_json,type_distribution_json=excluded.type_distribution_json,
                    retrieved_at=excluded.retrieved_at,source_file=excluded.source_file''',(
                    r['journal_id'],status,r.get('openalex_source_id'),r.get('matched_issn'),r.get('display_name'),
                    r.get('production_2025'),r.get('baseline_median_2020_2024'),r.get('production_ratio'),r.get('works_count'),r.get('cited_by_count'),
                    r.get('retracted_count'),r.get('retraction_rate'),json.dumps(r.get('counts_by_year'),ensure_ascii=False),
                    json.dumps(r.get('type_distribution_2020_2025'),ensure_ascii=False),r.get('retrieved_at'),source_file
                ))
                completed+=1
            elif status=='ambiguous':
                base=con.execute('SELECT preferred_title,issns FROM section2_decision_v08 WHERE journal_id=?',(r['journal_id'],)).fetchone() or (None,None)
                con.execute('''INSERT INTO openalex_identity_review_v08(journal_id,preferred_title,issns,candidates_json,status)
                    VALUES (?,?,?,?, 'pending_human_review')
                    ON CONFLICT(journal_id) DO UPDATE SET candidates_json=excluded.candidates_json,status='pending_human_review' ''',
                    (r['journal_id'],base[0],base[1],json.dumps(r.get('candidates'),ensure_ascii=False)))
                ambiguous+=1
            else:
                other+=1
        qpath=Path(args.queue)
        if qpath.exists():
            rows=list(csv.DictReader(qpath.open(encoding='utf-8',newline='')))
            con.execute('DELETE FROM openalex_queue_v08')
            con.executemany('''INSERT INTO openalex_queue_v08(
                journal_id,preferred_title,issns,status,openalex_source_id,matched_issn,attempts,last_attempt,error,batch
            ) VALUES (?,?,?,?,?,?,?,?,?,?)''',[
                (r.get('journal_id'),r.get('preferred_title'),r.get('issns'),r.get('status'),r.get('openalex_source_id') or None,
                 r.get('matched_issn') or None,int(r.get('attempts') or 0),r.get('last_attempt') or None,r.get('error') or None,int(r.get('batch') or 0))
                for r in rows
            ])
    check=con.execute('PRAGMA integrity_check').fetchone()[0]
    print({'completed_imported':completed,'ambiguous_imported':ambiguous,'other_results':other,'integrity':check})
    con.close()

if __name__=='__main__':
    main()
