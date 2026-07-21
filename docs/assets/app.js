'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt=(v,d=2)=>v===null||v===undefined||Number.isNaN(Number(v))?'—':Number(v).toLocaleString('es-PE',{maximumFractionDigits:d});
const pct=v=>v===null||v===undefined||Number.isNaN(Number(v))?'—':(Number(v)*100).toLocaleString('es-PE',{maximumFractionDigits:1})+' %';
const signal=v=>v==='Extreme'?'Extrema':v==='Moderate'?'Moderada':'Sin señal';
let index=[], filtered=[], active=-1;
async function init(){
  try{
    const [i,s]=await Promise.all([fetch('data/search-index.json').then(r=>r.json()),fetch('data/summary.json').then(r=>r.json())]);
    index=i; filtered=i;
    $('#datasetMeta').textContent=`Interfaz ${s.version} · datos ${s.data_version||s.version} · ${Number(s.journals).toLocaleString('es-PE')} revistas · OpenAlex: ${Number(s.openalex_completed).toLocaleString('es-PE')} completadas`;
    const areas=[...new Set(i.map(x=>x.a).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    $('#areaFilter').insertAdjacentHTML('beforeend',areas.map(a=>`<option>${esc(a)}</option>`).join(''));
  }catch(e){showError('No se pudo cargar el índice de revistas.');}
}
function normalize(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function updateSuggestions(){
  const q=normalize($('#query').value), status=$('#statusFilter').value, area=$('#areaFilter').value;
  $('#clear').hidden=!q;
  if(!q){$('#suggestions').hidden=true;return;}
  filtered=index.filter(x=>(!status||x.s===status)&&(!area||x.a===area)&&(normalize(x.t).includes(q)||normalize(x.i).includes(q))).slice(0,15);
  active=-1;
  const box=$('#suggestions');
  box.innerHTML=filtered.length?filtered.map((x,n)=>`<button class="suggestion" data-n="${n}" role="option"><strong>${esc(x.t)}</strong><small>${esc(x.i||'Sin ISSN')} · ${esc(x.s)}</small></button>`).join(''):`<div class="suggestion"><strong>Sin coincidencias</strong><small>Prueba otra parte del título o ISSN.</small></div>`;
  box.hidden=false; $('#query').setAttribute('aria-expanded','true');
  box.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>select(filtered[Number(b.dataset.n)])));
}
async function select(item){
  $('#suggestions').hidden=true; $('#query').value=item.t; $('#initial').hidden=true; $('#detail').hidden=true; $('#error').hidden=true; $('#loading').hidden=false;
  try{
    const base=await fetch(`data/journals/${item.h}.json`).then(r=>{if(!r.ok)throw new Error();return r.json()});
    let oa=null;
    try{const rr=await fetch(`data/openalex/${item.h}.json`);if(rr.ok){const d=await rr.json();oa=d[item.id]||null;}}catch(_e){}
    render(base[item.id],oa); $('#detail').hidden=false;
  }catch(e){showError('No se pudo cargar la ficha de esta revista.');}
  finally{$('#loading').hidden=true;}
}
function badgeClass(s){return s==='Alerta alta'?'high':s==='Retirada / desindexada'?'removed':s==='Alerta moderada'?'moderate':s==='Sin señales cuantitativas'?'clear':s==='Evaluación limitada'?'limited':'neutral';}
function metric(label,value,note=''){return `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong>${note?`<small>${esc(note)}</small>`:''}</div>`;}
function render(d,oa){
  if(!d)return showError('La ficha no está disponible.');
  const scSig=signal(d.production_signal_scimago), inSig=signal(d.production_signal_incites), sjSig=signal(d.sjr_trajectory_signal);
  const open=oa||d.openalex||{status:'pending'};
  $('#detail').innerHTML=`
  <section class="journal-header">
    <div class="title-row"><div><h2>${esc(d.preferred_title)}</h2><div class="meta">ISSN/eISSN: ${esc(d.issns||'No disponible')}<br>Área principal: ${esc(d.primary_area_proxy||'No clasificada')}</div></div><span class="badge ${badgeClass(d.public_primary_status_v08)}">${esc(d.public_primary_status_v08)}</span></div>
    <p class="summary-message">${esc(d.public_message_v08)}</p>
    <div class="source-grid">
      <div class="source-state scopus-state"><span>Scopus</span><strong>${esc(d.scopus_status||'No encontrado')}</strong></div>
      <div class="source-state wos-state"><span>Web of Science</span><strong>${esc(d.wos_status||'No encontrado')}</strong></div>
      <div class="source-state official-state"><span>Antecedente oficial</span><strong>${esc(d.official_status||'Sin retiro documentado')}</strong></div>
    </div>
  </section>
  <section class="panel quantitative-panel">
    <div class="panel-head"><div><p class="panel-kicker">Evaluación bibliométrica</p><h3>Indicadores cuantitativos por fuente</h3></div><small>Metodología cuantitativa v0.8</small></div>
    <div class="panel-body">
      <div class="source-separation">
        <section class="source-block source-block-scimago" aria-labelledby="scimagoTitle">
          <div class="source-block-head">
            <div><span class="source-dot" aria-hidden="true"></span><h4 id="scimagoTitle">Scopus / SCImago</h4></div>
            <small>SCImago, basado en datos de Scopus</small>
          </div>
          <div class="source-block-body">
            <div class="source-result-row"><span>Señal de producción</span><strong>${esc(scSig)}</strong></div>
            <div class="source-metrics">
              ${metric('Documentos SCImago 2025',fmt(d.sjr_docs_2025,0))}
              ${metric('Mediana 2020–2024',fmt(d.sjr_docs_baseline_median,1))}
              ${metric('Ratio de producción',fmt(d.sjr_production_ratio,2),scSig)}
              ${metric('Persistencia SCImago',fmt(d.production_persistent_years,0)+' de 3 años')}
              ${metric('SJR 2025',fmt(d.sjr_2025,3))}
              ${metric('Mediana SJR 2020–2024',fmt(d.sjr_baseline_median,3))}
              ${metric('Variación SJR',fmt(d.sjr_change_ratio,2),sjSig+' · contextual')}
              ${metric('Cuartil SJR 2025',d.sjr_quartile_2025||'—')}
            </div>
            <p class="source-explain">La producción, persistencia, SJR y cuartil se interpretan únicamente dentro de SCImago. La variación del SJR es contextual y no modifica por sí sola la categoría pública.</p>
          </div>
        </section>
        <section class="source-block source-block-wos" aria-labelledby="wosTitle">
          <div class="source-block-head">
            <div><span class="source-dot" aria-hidden="true"></span><h4 id="wosTitle">Web of Science / InCites</h4></div>
            <small>InCites y JCR, ecosistema Clarivate</small>
          </div>
          <div class="source-block-body">
            <div class="source-result-row"><span>Señal de producción</span><strong>${esc(inSig)}</strong></div>
            <div class="source-metrics">
              ${metric('Documentos WoS 2025',fmt(d.incites_docs_2025,0))}
              ${metric('Mediana WoS 2020–2024',fmt(d.incites_docs_baseline_median,1))}
              ${metric('Ratio de producción WoS',fmt(d.incites_production_ratio,2),inSig)}
              ${metric('Autocitación de la fuente',pct(d.source_self_cite_share),signal(d.source_self_signal_v07))}
              ${metric('JIF',fmt(d.jif_current,3))}
              ${metric('JIF sin autocitas',fmt(d.jif_without_self,3))}
              ${metric('Dependencia del JIF',pct(d.jif_self_dependency),signal(d.jif_self_signal_v07))}
              ${metric('CNCI 2024',fmt(d.cnci_2024,3),signal(d.cnci_signal_v07))}
            </div>
            <p class="source-explain">Los indicadores WoS, InCites y JCR se interpretan dentro de su propia cobertura. No se promedian con SJR ni con la producción de SCImago.</p>
          </div>
        </section>
      </div>
      <div class="cross-source-note"><strong>Lectura conjunta:</strong> ${esc(d.production_concordance||'Sin señal comparable')}. La coincidencia entre fuentes se usa como corroboración, no como una métrica fusionada.</div>
    </div>
  </section>
  <section class="panel complementary-panel"><div class="panel-head"><div><p class="panel-kicker">Información complementaria</p><h3 class="source-label openalex">OpenAlex</h3></div><small>Enriquecimiento progresivo por API</small></div><div class="panel-body">${renderOpenAlex(open)}</div></section>
  <section class="panel"><div class="panel-head"><h3>Interpretación cuantitativa</h3><small>Resultado integrado, fuentes trazables</small></div><div class="panel-body"><p>${esc(d.quantitative_reasons_v08||'Sin observaciones adicionales.')}</p><p class="explain"><strong>Confianza:</strong> ${esc(d.data_sufficiency||'No determinada')}. La conclusión cuantitativa orienta una revisión y no constituye una acusación automática.</p></div></section>
  <section class="panel"><div class="panel-head"><h3>Evaluación cualitativa humana</h3></div><div class="panel-body"><p><strong>Estado:</strong> ${esc(d.qualitative_review_status||'No realizada')}</p><p>${esc(d.qualitative_review_result||'No existe una revisión humana documentada para esta revista.')}</p></div></section>`;
}
function renderOpenAlex(o){
  if(!o||o.status==='pending')return `<div class="pending"><strong>Procesamiento pendiente</strong><p>GitHub Actions continuará consultando la API por lotes. OpenAlex no afecta todavía la categoría pública.</p></div>`;
  if(o.status==='ambiguous')return `<div class="pending"><strong>Vinculación ambigua</strong><p>Los ISSN conducen a más de una fuente OpenAlex. El sistema no fusionó los datos y requiere resolución de identidad.</p></div>`;
  if(o.status==='not_found')return `<div class="pending"><strong>No encontrada por ISSN</strong><p>OpenAlex no devolvió una fuente de tipo revista para los ISSN disponibles. Esto no constituye una señal negativa.</p></div>`;
  if(o.status==='error')return `<div class="pending"><strong>Error temporal de consulta</strong><p>La revista volverá a intentarse en una ejecución posterior.</p></div>`;
  if(o.status!=='completed')return `<div class="pending"><strong>Estado OpenAlex no determinado</strong></div>`;
  return `<div class="metrics">${metric('Fuente vinculada',o.display_name||'Sí')}${metric('Trabajos OpenAlex',fmt(o.works_count,0))}${metric('Producción 2025',fmt(o.production_2025,0))}${metric('Ratio de producción',fmt(o.production_ratio,2),'Pendiente de calibración')}${metric('Trabajos retractados',fmt(o.retracted_count,0))}${metric('Tasa de retractación',pct(o.retraction_rate))}</div><p class="explain">Las retracciones deben verificarse con la fuente editorial o Retraction Watch. El ratio OpenAlex es complementario y aún no cambia la clasificación.</p>`;
}
function showError(msg){$('#loading').hidden=true;$('#detail').hidden=true;$('#initial').hidden=true;$('#error').textContent=msg;$('#error').hidden=false;}
$('#query').addEventListener('input',updateSuggestions);
$('#query').addEventListener('keydown',e=>{const btns=[...$('#suggestions').querySelectorAll('button')];if(e.key==='ArrowDown'){e.preventDefault();active=Math.min(active+1,btns.length-1);}else if(e.key==='ArrowUp'){e.preventDefault();active=Math.max(active-1,0);}else if(e.key==='Enter'&&active>=0){e.preventDefault();btns[active]?.click();}btns.forEach((b,i)=>b.classList.toggle('active',i===active));});
$('#clear').addEventListener('click',()=>{$('#query').value='';$('#clear').hidden=true;$('#suggestions').hidden=true;$('#query').focus();});
$('#statusFilter').addEventListener('change',updateSuggestions);$('#areaFilter').addEventListener('change',updateSuggestions);
$('#resetFilters').addEventListener('click',()=>{$('#statusFilter').value='';$('#areaFilter').value='';updateSuggestions();});
init();
