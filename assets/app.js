"use strict";

const STATE = {
  catalog: [],
  details: new Map(),
  detailPromises: new Map(),
  complementary: null,
  complementaryPromise: null,
  openAlexCore: new Map(),
  openAlexCorePromises: new Map(),
  openAlexEnriched: new Map(),
  openAlexEnrichedPromises: new Map(),
  loaded: false,
  suggestions: [],
  activeSuggestion: -1,
  selected: null
};

const $ = {};
let suggestTimer;

 document.addEventListener("DOMContentLoaded", init);

async function init() {
  Object.assign($, {
    query: document.getElementById("query"),
    clear: document.getElementById("clearQuery"),
    suggestions: document.getElementById("suggestions"),
    catalogLoading: document.getElementById("catalogLoading"),
    loadError: document.getElementById("loadError"),
    welcome: document.getElementById("welcome"),
    journalView: document.getElementById("journalView"),
    journalLoading: document.getElementById("journalLoading"),
    journalContent: document.getElementById("journalContent")
  });

  bindEvents();

  try {
    const payload = await loadCatalog();
    STATE.catalog = hydrate(payload.fields, payload.rows);
    STATE.loaded = true;
    $.catalogLoading.hidden = true;
    restoreFromUrl();
  } catch (error) {
    console.error(error);
    $.catalogLoading.hidden = true;
    $.loadError.hidden = false;
    $.loadError.innerHTML = location.protocol === "file:"
      ? "No se pudo cargar la base. Ejecute <strong>INICIAR_SERVIDOR_LOCAL.bat</strong> desde la carpeta descomprimida."
      : "No fue posible cargar la base de consulta.";
  }
}

function bindEvents() {
  $.query.addEventListener("input", () => {
    $.clear.hidden = !$.query.value;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(renderSuggestions, 110);
  });

  $.query.addEventListener("keydown", event => {
    if ($.suggestions.hidden || !STATE.suggestions.length) {
      if (event.key === "Enter") {
        event.preventDefault();
        const exact = exactMatch($.query.value);
        if (exact) selectJournal(exact);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion(Math.min(STATE.activeSuggestion + 1, STATE.suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion(Math.max(STATE.activeSuggestion - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectJournal(STATE.suggestions[Math.max(STATE.activeSuggestion, 0)]);
    } else if (event.key === "Escape") {
      hideSuggestions();
    }
  });

  $.clear.addEventListener("click", clearSelection);

  document.addEventListener("click", event => {
    if (!event.target.closest(".live-search")) hideSuggestions();
    const copyButton = event.target.closest("[data-copy-journal]");
    if (copyButton) copyJournalLink(copyButton.dataset.copyJournal);

    const openAlexTab = event.target.closest("[data-openalex-tab]");
    if (openAlexTab) switchOpenAlexTab(openAlexTab);
  });
}

async function loadCatalog() {
  if (location.protocol === "file:") throw new Error("local-file");
  if ("DecompressionStream" in window) {
    try {
      const response = await fetch("data/catalog.json.gz");
      if (!response.ok) throw new Error("catalog-gzip");
      const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).json();
    } catch (error) {
      console.warn("Se usará el catálogo sin compresión.", error);
    }
  }
  const response = await fetch("data/catalog.json");
  if (!response.ok) throw new Error("catalog");
  return response.json();
}

function hydrate(fields, rows) {
  return rows.map(values => {
    const journal = {};
    fields.forEach((field, index) => journal[field] = values[index] ?? "");
    journal._search = normalize(journal.search_text);
    journal._title = normalize(journal.preferred_title);
    journal._issn = normalizeIssn(journal.issns);
    return journal;
  });
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeIssn(value) {
  return String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
}

function validQuery(value) {
  return normalize(value).replaceAll(" ", "").length >= 3 || normalizeIssn(value).length >= 4;
}

function matches(journal, query) {
  const normalized = normalize(query);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const issnQuery = normalizeIssn(query);
  return (issnQuery.length >= 4 && journal._issn.includes(issnQuery)) ||
    (tokens.length && tokens.every(token => journal._search.includes(token)));
}

function matchRank(journal, query) {
  const normalized = normalize(query);
  const issnQuery = normalizeIssn(query);
  if (issnQuery.length === 8 && journal._issn.includes(issnQuery)) return 0;
  if (journal._title === normalized) return 1;
  if (journal._title.startsWith(normalized)) return 2;
  return 3;
}

function renderSuggestions() {
  if (!STATE.loaded) return;
  const query = $.query.value.trim();

  if (!validQuery(query)) {
    hideSuggestions();
    return;
  }

  STATE.suggestions = STATE.catalog
    .filter(journal => matches(journal, query))
    .sort((a, b) => matchRank(a, query) - matchRank(b, query) || a.preferred_title.localeCompare(b.preferred_title, "es"))
    .slice(0, 9);

  STATE.activeSuggestion = -1;

  if (!STATE.suggestions.length) {
    $.suggestions.innerHTML = '<div class="suggestion-empty">No se encontraron coincidencias. Revise el título o el ISSN.</div>';
    $.suggestions.hidden = false;
    $.query.setAttribute("aria-expanded", "true");
    return;
  }

  $.suggestions.innerHTML = STATE.suggestions.map((journal, index) => `
    <button class="suggestion" type="button" role="option" data-suggestion-index="${index}" aria-selected="false">
      <span class="suggestion-title">${highlight(journal.preferred_title, query)}</span>
      <span class="suggestion-issn">ISSN/eISSN: ${escapeHtml(journal.issns || "No disponible")}</span>
    </button>
  `).join("");

  $.suggestions.querySelectorAll("[data-suggestion-index]").forEach(button => {
    button.addEventListener("click", () => selectJournal(STATE.suggestions[Number(button.dataset.suggestionIndex)]));
  });

  $.suggestions.hidden = false;
  $.query.setAttribute("aria-expanded", "true");
}

function setActiveSuggestion(index) {
  STATE.activeSuggestion = index;
  const buttons = [...$.suggestions.querySelectorAll("[data-suggestion-index]")];
  buttons.forEach((button, buttonIndex) => {
    const active = buttonIndex === index;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function hideSuggestions() {
  $.suggestions.hidden = true;
  $.query.setAttribute("aria-expanded", "false");
  STATE.activeSuggestion = -1;
}

function exactMatch(value) {
  const title = normalize(value);
  const issnValue = normalizeIssn(value);
  return STATE.catalog.find(journal =>
    journal._title === title ||
    (issnValue.length === 8 && journal._issn.includes(issnValue))
  );
}

async function selectJournal(journal, options = {}) {
  if (!journal) return;
  STATE.selected = journal;
  $.query.value = journal.preferred_title;
  $.clear.hidden = false;
  hideSuggestions();
  $.welcome.hidden = true;
  $.journalView.hidden = false;
  $.journalLoading.hidden = false;
  $.journalContent.innerHTML = "";

  const url = new URL(location.href);
  url.searchParams.delete("q");
  url.searchParams.set("j", journal.journal_id);
  history.replaceState({}, "", url);

  try {
    const [payload, complementary] = await Promise.all([
      loadDetailChunk(journal.detail_chunk),
      loadComplementaryForJournal(journal)
    ]);
    const detail = payload.journals[journal.journal_id] || { events: [], sjr: [], incites: [], sources: [] };
    $.journalContent.innerHTML = journalHtml(journal, detail, complementary);
    $.journalLoading.hidden = true;
    if (!options.noScroll) {
      window.scrollTo({ top: $.journalView.offsetTop - 88, behavior: "smooth" });
    }
  } catch (error) {
    console.error(error);
    $.journalLoading.hidden = true;
    $.journalContent.innerHTML = '<div class="error-box">No fue posible cargar la ficha de esta revista.</div>';
  }
}

function clearSelection() {
  $.query.value = "";
  $.clear.hidden = true;
  hideSuggestions();
  STATE.selected = null;
  $.journalView.hidden = true;
  $.journalContent.innerHTML = "";
  $.welcome.hidden = false;
  const url = new URL(location.href);
  url.searchParams.delete("j");
  url.searchParams.delete("q");
  history.replaceState({}, "", url);
  $.query.focus();
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const journalId = params.get("j");
  const query = params.get("q");

  if (journalId) {
    const journal = STATE.catalog.find(item => item.journal_id === journalId);
    if (journal) selectJournal(journal, { noScroll: true });
    return;
  }

  if (query) {
    const journal = exactMatch(query);
    if (journal) selectJournal(journal, { noScroll: true });
    else {
      $.query.value = query;
      $.clear.hidden = false;
      renderSuggestions();
    }
  }
}

async function loadDetailChunk(chunk) {
  if (STATE.details.has(chunk)) return STATE.details.get(chunk);
  if (STATE.detailPromises.has(chunk)) return STATE.detailPromises.get(chunk);

  const promise = (async () => {
    let data;
    if ("DecompressionStream" in window) {
      try {
        const response = await fetch(`data/details/${chunk}.json.gz`);
        if (!response.ok) throw new Error("detail-gzip");
        const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
        data = await new Response(stream).json();
      } catch (error) {
        data = await fetch(`data/details/${chunk}.json`).then(response => response.json());
      }
    } else {
      data = await fetch(`data/details/${chunk}.json`).then(response => response.json());
    }
    STATE.details.set(chunk, data);
    return data;
  })();

  STATE.detailPromises.set(chunk, promise);
  return promise;
}

async function loadComplementaryData() {
  if (STATE.complementary) return STATE.complementary;
  if (STATE.complementaryPromise) return STATE.complementaryPromise;

  STATE.complementaryPromise = (async () => {
    try {
      let payload;
      if ("DecompressionStream" in window) {
        try {
          const response = await fetch("data/complementary/pilot_integrated.json.gz");
          if (!response.ok) throw new Error("complementary-gzip");
          const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
          payload = await new Response(stream).json();
        } catch (error) {
          const response = await fetch("data/complementary/pilot_integrated.json");
          if (!response.ok) throw new Error("complementary-json");
          payload = await response.json();
        }
      } else {
        const response = await fetch("data/complementary/pilot_integrated.json");
        if (!response.ok) throw new Error("complementary-json");
        payload = await response.json();
      }
      STATE.complementary = payload.records || {};
      return STATE.complementary;
    } catch (error) {
      console.warn("No se cargaron los datos complementarios.", error);
      STATE.complementary = {};
      return STATE.complementary;
    }
  })();

  return STATE.complementaryPromise;
}


async function loadOpenAlexShard(kind, chunk) {
  const cache = kind === "core" ? STATE.openAlexCore : STATE.openAlexEnriched;
  const promises = kind === "core" ? STATE.openAlexCorePromises : STATE.openAlexEnrichedPromises;
  if (cache.has(chunk)) return cache.get(chunk);
  if (promises.has(chunk)) return promises.get(chunk);

  const promise = (async () => {
    let payload = { records: {} };
    const base = `data/openalex_full/${kind}/${chunk}.json`;
    try {
      if ("DecompressionStream" in window) {
        try {
          const response = await fetch(`${base}.gz`);
          if (!response.ok) throw new Error(`openalex-${kind}-gzip`);
          const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
          payload = await new Response(stream).json();
        } catch (error) {
          const response = await fetch(base);
          if (response.ok) payload = await response.json();
        }
      } else {
        const response = await fetch(base);
        if (response.ok) payload = await response.json();
      }
    } catch (error) {
      console.warn(`No se cargó el shard OpenAlex ${kind} ${chunk}.`, error);
    }
    cache.set(chunk, payload);
    return payload;
  })();

  promises.set(chunk, promise);
  return promise;
}

function mergeOpenAlexRecords(...records) {
  const result = {};
  records.filter(Boolean).forEach(record => {
    Object.assign(result, record);
    if (record.source) result.source = { ...(result.source || {}), ...record.source };
    if (record.top) {
      result.top = { ...(result.top || {}) };
      ["topics", "countries", "institutions"].forEach(key => {
        if (Array.isArray(record.top[key]) && record.top[key].length) result.top[key] = record.top[key];
      });
    }
    if (Array.isArray(record.production_by_year) && record.production_by_year.length) result.production_by_year = record.production_by_year;
    if (Array.isArray(record.quality_flags) && record.quality_flags.length) result.quality_flags = record.quality_flags;
    if (Array.isArray(record.retracted_works) && record.retracted_works.length) result.retracted_works = record.retracted_works;
  });
  return Object.keys(result).length ? result : null;
}

async function loadComplementaryForJournal(journal) {
  const [pilotRecords, corePayload, enrichedPayload] = await Promise.all([
    loadComplementaryData(),
    loadOpenAlexShard("core", journal.detail_chunk),
    loadOpenAlexShard("enriched", journal.detail_chunk)
  ]);
  const pilot = pilotRecords[journal.journal_id] || {};
  const core = (corePayload.records || {})[journal.journal_id] || null;
  const enriched = (enrichedPayload.records || {})[journal.journal_id] || null;
  const output = { ...pilot };
  const mergedOpenAlex = mergeOpenAlexRecords(pilot.openalex, core, enriched);
  if (mergedOpenAlex) output.openalex = mergedOpenAlex;
  return Object.keys(output).length ? output : null;
}

function journalHtml(journal, detail, complementary) {
  const timelineEvents = combinedTimelineEvents(detail, complementary);
  const hasEvents = timelineEvents.length > 0;
  const displayQuantStatus = effectiveQuantitativeStatus(journal, detail);
  const officialSection = evaluationSummaryHtml(journal, detail, complementary);
  const sourceAvailability = bibliometricSourceAvailability(journal, detail);
  const productionHistory = productionHistoryHtml(detail, sourceAvailability);
  const impactHistory = impactHistoryHtml(detail, sourceAvailability);
  const timelineSection = hasEvents ? `
    <section class="journal-section timeline-section">
      <div class="section-heading">
        <div><p class="section-kicker">Historia documentada</p><h2>Cronología de eventos relevantes</h2></div>
      </div>
      <p class="timeline-intro">Integra cambios de indexación documentados y, cuando existen, eventos editoriales prioritarios localizados en fuentes externas.</p>
      ${timelineHtml(timelineEvents)}
    </section>` : "";

  return `
    <article class="journal-sheet" id="${escapeHtml(journal.journal_id)}">
      <header class="journal-sheet-header">
        <div class="journal-heading-main">
          <div>
            <p class="sheet-kicker">Revista seleccionada</p>
            <h1>${escapeHtml(journal.preferred_title)}</h1>
            <p class="journal-identifiers"><strong>ISSN/eISSN:</strong> ${escapeHtml(journal.issns || "No disponible")}</p>
          </div>
        </div>
      </header>

      <div class="general-grid">
        ${infoItem("Editorial", journal.publisher)}
        ${infoItem("País", journal.country)}
        ${infoItem("Área principal", journal.primary_area)}
        ${infoItem("Áreas registradas", journal.all_areas)}
      </div>

      ${officialSection}

      <section class="journal-section sources-section">
        <div class="section-heading">
          <div><p class="section-kicker">Cobertura y situación vigente</p><h2>Estado en las fuentes</h2></div>
        </div>
        <div class="source-list">
          ${sourceRow("scopus", "Scopus / SCImago", scopusStatus(journal), journal.scopus_coverage ? `Cobertura registrada: ${journal.scopus_coverage}` : "", "")}
          ${sourceRow("wos", "Web of Science / InCites", wosStatus(journal, detail), wosSourceExtra(journal, detail), "")}
          ${sourceRow("doaj", "DOAJ", doajStatus(journal), "", journal.doaj_url)}
        </div>
        ${inactiveWithoutEventNote(journal)}
      </section>

      ${timelineSection}

      <section class="journal-section quantitative-section">
        <div class="section-heading">
          <div><p class="section-kicker">Análisis bibliométrico</p><h2>Evaluación cuantitativa</h2></div>
          <span class="quant-badge ${quantClass(displayQuantStatus)}">${escapeHtml(quantLabel(displayQuantStatus))}</span>
        </div>
        <div class="quant-summary">
          <div>
            <span class="label">Suficiencia de datos</span>
            <strong>${escapeHtml(sufficiencyLabel(journal.data_sufficiency))}</strong>
          </div>
          <p>${escapeHtml(quantitativeInterpretation(journal, detail))}</p>
        </div>
        ${journal.bibliometric_support === "High - validation" && displayQuantStatus === "No quantitative signals" ? `
          <div class="support-note">
            <span aria-hidden="true">✓</span>
            <div><span class="support-label">Lectura complementaria</span><strong>Indicadores bibliométricos favorables</strong><p>La revista se encuentra vigente en Scopus y Web of Science, presenta una trayectoria bibliométrica sólida, se ubica en cuartiles altos y no muestra anomalías cuantitativas con los datos disponibles. En términos analíticos, este perfil sugiere un menor nivel de riesgo para la toma de decisiones, pero no constituye una garantía concluyente ni reemplaza la revisión cualitativa y editorial.</p></div>
          </div>` : ""}
        ${metricsHtml(journal, detail, sourceAvailability)}
      </section>

      ${productionHistory}

      ${impactHistory}

      ${openAlexSectionHtml(complementary?.openalex)}

      <section class="journal-section qualitative-human-section">
        <div class="section-heading">
          <div><p class="section-kicker">Revisión especializada</p><h2>Evaluación cualitativa humana</h2></div>
        </div>
        ${qualitativeHtml(journal)}
      </section>

      ${automatedQualitativeSectionHtml(complementary, detail)}

      <aside class="interpretation-note">
        <strong>Interpretación responsable</strong>
        <p>La ausencia de señales no garantiza integridad. Una alerta cuantitativa no demuestra por sí sola una mala práctica. El resultado debe leerse junto con los hechos oficiales, la suficiencia de datos y la revisión cualitativa.</p>
      </aside>

      <div class="sheet-actions">
        <button type="button" class="secondary-button" data-copy-journal="${escapeHtml(journal.journal_id)}">Copiar enlace de esta ficha</button>
        <a href="#searchSection">Realizar otra búsqueda</a>
      </div>
    </article>
  `;
}

function infoItem(label, value) {
  if (!value || value === "Unclassified") return "";
  return `<div class="info-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function primaryStatus(journal, detail) {
  if (journal.official_status === "Current removal") return { label: "Retirada / desindexada", className: "removal" };
  if (journal.official_status === "Historical removal") return { label: "Antecedente de retiro", className: "historical" };
  const status = effectiveQuantitativeStatus(journal, detail);
  return { label: quantLabel(status), className: quantClass(status) };
}

function hasHistoricalQuantitativeData(journal, detail) {
  const sjr = Array.isArray(detail?.sjr) && detail.sjr.some(item => item.total_docs_year !== "" && item.total_docs_year != null);
  const incites = Array.isArray(detail?.incites) && detail.incites.some(item => item.wos_documents !== "" && item.wos_documents != null);
  const metric = [journal.sjr, journal.jif_current, journal.jci, journal.cnci_2024, journal.source_self_cite_share]
    .some(value => value !== "" && value != null);
  return sjr || incites || metric;
}

function effectiveQuantitativeStatus(journal, detail) {
  if (journal.quantitative_status === "Not applicable" && hasHistoricalQuantitativeData(journal, detail)) return "Limited data";
  return journal.quantitative_status;
}

function historicalRange(detail) {
  const years = [];
  for (const item of [...(detail?.sjr || []), ...(detail?.incites || [])]) {
    const year = Number(item.year);
    if (Number.isFinite(year)) years.push(year);
  }
  if (!years.length) return "";
  return `${Math.min(...years)}–${Math.max(...years)}`;
}

function sourceSeriesValues(series, key) {
  return (Array.isArray(series) ? series : [])
    .filter(item => item && item[key] !== "" && item[key] != null && Number.isFinite(Number(item[key])))
    .sort((a, b) => Number(a.year) - Number(b.year));
}

function sourceSeriesRange(series, key) {
  const valid = sourceSeriesValues(series, key);
  if (!valid.length) return "";
  return `${valid[0].year}–${valid[valid.length - 1].year}`;
}

function bibliometricSourceAvailability(journal, detail) {
  const sjrSeries = sourceSeriesValues(detail?.sjr, "total_docs_year");
  const incitesSeries = sourceSeriesValues(detail?.incites, "wos_documents");
  const scimago = ["Active", "Inactive"].includes(journal.scopus_status)
    || Boolean(journal.scopus_source_ids || journal.scopus_coverage)
    || sjrSeries.length > 0
    || hasMetricValue(journal.sjr);
  const wos = journal.wos_status === "Current"
    || Boolean(Number(journal.wos_historical_noncurrent || 0))
    || Boolean(journal.wos_historical_range || journal.wos_indexes)
    || incitesSeries.length > 0
    || [journal.jif_current, journal.jci, journal.cnci_2024, journal.source_self_cite_share].some(hasMetricValue);
  return { scimago, wos };
}

function productionHistoryHtml(detail, availability) {
  const charts = [];
  if (availability.scimago && sourceSeriesValues(detail?.sjr, "total_docs_year").length) {
    charts.push(chartBlock("SCImago / Scopus", detail.sjr || [], "total_docs_year", "scopus", "documentos", { showPointValues: true }));
  }
  if (availability.wos && sourceSeriesValues(detail?.incites, "wos_documents").length) {
    charts.push(chartBlock("InCites / Web of Science", detail.incites || [], "wos_documents", "wos", "documentos", { showPointValues: true }));
  }
  if (!charts.length) return "";
  return `<section class="journal-section history-section">
    <div class="section-heading"><div><p class="section-kicker">Información histórica disponible</p><h2>Evolución de la producción</h2></div></div>
    <div class="charts-grid adaptive-charts ${charts.length === 1 ? "single-source" : ""}">${charts.join("")}</div>
    <p class="history-note">Se muestra únicamente la información de las fuentes en las que la revista tiene o tuvo cobertura. La ausencia de datos recientes no elimina la trayectoria histórica disponible.</p>
  </section>`;
}

function impactHistoryHtml(detail, availability) {
  const sjrSeries = availability.scimago ? sourceSeriesValues(detail?.sjr, "sjr") : [];
  if (!sjrSeries.length) return "";
  const chart = chartBlock("Evolución histórica del SJR / SCImago", detail.sjr || [], "sjr", "scopus", "SJR", { decimals: 3, showPointValues: true, annotationKey: "quartile", annotationLabel: "Cuartil" });
  return `<section class="journal-section impact-history-section">
    <div class="section-heading"><div><p class="section-kicker">Trayectoria del impacto de la revista</p><h2>Evolución histórica del SJR</h2></div></div>
    <div class="charts-grid adaptive-charts single-source">${chart}</div>
    <p class="history-note">Los archivos SCImago permiten mostrar una serie anual real del SJR. El JIF se presenta en el bloque Web of Science / InCites como el valor disponible en la exportación, sin reconstruir una trayectoria histórica. El CNCI se mantiene como indicador documental complementario y no sustituye al JIF.</p>
  </section>`;
}

function quantitativeInterpretation(journal, detail) {
  const status = effectiveQuantitativeStatus(journal, detail);
  const availability = bibliometricSourceAvailability(journal, detail);
  const sjrRange = sourceSeriesRange(detail?.sjr, "total_docs_year");
  const incitesRange = sourceSeriesRange(detail?.incites, "wos_documents");
  if (status === "Limited data") {
    const parts = [];
    if (availability.scimago) {
      const latest = sourceSeriesValues(detail?.sjr, "total_docs_year").at(-1);
      if (sjrRange && latest && Number(latest.year) < 2025) {
        parts.push(`SCImago dispone de una serie histórica ${sjrRange}, pero termina antes del periodo de evaluación 2025`);
      } else if (!hasMetricValue(journal.sjr_production_ratio)) {
        parts.push("SCImago no reúne todavía los años o el volumen mínimo para calcular crecimiento reciente");
      }
    }
    if (availability.wos) {
      if (incitesRange && !hasMetricValue(journal.incites_production_ratio)) {
        parts.push(`InCites dispone de información para ${incitesRange}, pero no reúne todos los mínimos para evaluar crecimiento reciente`);
      } else if (!incitesRange) {
        parts.push("InCites no reporta una serie anual comparable en los archivos integrados");
      }
    }
    if (parts.length) return `${parts.join(". ")}. Los datos existentes se muestran para describir la trayectoria de la revista, pero no permiten aplicar todos los criterios cuantitativos actuales.`;
    return "Existe información bibliométrica parcial, pero no alcanza los mínimos de años, continuidad o volumen requeridos para una evaluación cuantitativa completa.";
  }
  if (status === "No quantitative signals") return "Con los datos disponibles no se identificaron anomalías cuantitativas relevantes. Este resultado no equivale a una certificación de calidad o integridad editorial.";
  if (status === "Moderate alert") return "Se identificaron patrones cuantitativos que justifican una revisión cualitativa antes de formular una conclusión más amplia.";
  if (status === "High alert") return "Se identificaron patrones cuantitativos fuertes o combinados que requieren una revisión cualitativa prioritaria.";
  return "No se dispone de información suficiente para aplicar la evaluación cuantitativa.";
}

function evaluationSummaryHtml(journal, detail, complementary) {
  const scopusInactive = journal.scopus_status === "Inactive";
  const wosHistoricalAlert = wosNoLongerCurrent(journal, detail);
  const doajWithdrawn = journal.doaj_status === "Withdrawn";
  const autoStats = automatedPriorityStats(complementary);
  const quantStatus = effectiveQuantitativeStatus(journal, detail);
  const humanCompleted = journal.qualitative_review_status === "Completed";
  const humanResult = humanCompleted ? qualitativeLabel(journal.qualitative_review_result) : "";

  if (journal.official_status === "Current removal") {
    const additional = indexingAlertSummary(journal, detail, true);
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Retirada / desindexada</h2><p>Se registró un retiro o una desindexación oficial vigente en al menos una de las fuentes integradas.</p>${officialMeta(journal)}${additional}${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (journal.official_status === "Historical removal") {
    return `
      <section class="official-banner historical">
        <div class="official-icon">↺</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Antecedente histórico de retiro</h2><p>La revista presenta un retiro histórico documentado y un estado posterior que debe interpretarse junto con la cronología disponible.</p>${officialMeta(journal)}${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (scopusInactive || wosHistoricalAlert || doajWithdrawn) {
    const title = indexingAlertTitle(scopusInactive, wosHistoricalAlert, doajWithdrawn);
    const statements = [];
    if (scopusInactive) statements.push("aparece como inactiva en Scopus");
    if (wosHistoricalAlert) statements.push("tiene registros históricos en InCites, pero ya no figura como vigente en Web of Science");
    if (doajWithdrawn) statements.push("figura como retirada en DOAJ");
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>${escapeHtml(title)}</h2><p>La revista ${escapeHtml(joinSpanish(statements))}. Para fines de selección editorial, este resultado debe interpretarse como una señal de alerta.</p>${indexingAlertMeta(journal, detail)}${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (autoStats.total > 0) {
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Hallazgos editoriales que requieren revisión</h2><p>${escapeHtml(automatedPrioritySentence(autoStats))} Estos hallazgos aportan información relevante para la toma de decisiones, pero no permiten concluir por sí solos sobre la calidad o integridad global de la revista.</p>${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (humanCompleted && journal.qualitative_review_result === "Observed") {
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Revista observada en la revisión cualitativa</h2><p>La revisión humana documentó hallazgos que deben considerarse antes de tomar una decisión editorial.</p>${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (quantStatus === "High alert" || quantStatus === "Moderate alert" || (humanCompleted && journal.qualitative_review_result === "Monitor")) {
    const high = quantStatus === "High alert";
    return `
      <section class="official-banner ${high ? "removal" : "moderate"}">
        <div class="official-icon">${high ? "!" : "i"}</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>${high ? "Alerta cuantitativa alta" : "Se requiere revisión adicional"}</h2><p>${escapeHtml(quantitativeInterpretation(journal, detail))}</p>${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  if (humanCompleted && journal.qualitative_review_result === "No additional alert") {
    return `
      <section class="official-banner positive">
        <div class="official-icon">✓</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Sin hallazgos adicionales en la revisión humana</h2><p>La revisión cualitativa realizada no identificó hallazgos adicionales. Esta conclusión debe leerse junto con el estado de indexación y la evaluación cuantitativa.</p>${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
      </section>`;
  }

  return `
    <section class="official-banner neutral">
      <div class="official-icon">i</div>
      <div><p class="section-kicker">Resumen de la evaluación</p><h2>Sin alertas oficiales documentadas</h2><p>No se identificaron retiros, desindexaciones u otros cambios adversos documentados en las fuentes integradas.</p>${summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult)}</div>
    </section>`;
}

function summarySignalsHtml(autoStats, quantStatus, humanCompleted, humanResult) {
  const items = [];
  if (autoStats.total > 0) items.push(`<span><strong>Evaluación automatizada:</strong> ${escapeHtml(automatedPrioritySentence(autoStats))}</span>`);
  if (["High alert", "Moderate alert"].includes(quantStatus)) items.push(`<span><strong>Evaluación cuantitativa:</strong> ${escapeHtml(quantLabel(quantStatus))}</span>`);
  if (humanCompleted) items.push(`<span><strong>Revisión humana:</strong> ${escapeHtml(humanResult)}</span>`);
  return items.length ? `<div class="summary-signal-list">${items.join("")}</div>` : "";
}

function automatedPriorityStats(complementary) {
  const counts = {};
  const events = (complementary?.crossref?.events || []).filter(item => item.severity === "high_signal");
  const seen = new Set();
  events.forEach(event => {
    const key = normalizeDoi(event.notice_doi || event.work_doi) || `${event.event_type}|${event.notice_title}|${event.notice_date}`;
    if (seen.has(key)) return;
    seen.add(key);
    counts[event.event_type || "other"] = (counts[event.event_type || "other"] || 0) + 1;
  });
  (complementary?.openalex?.retracted_works || []).forEach(item => {
    const key = normalizeDoi(item.doi) || `openalex|${item.title}|${item.year}`;
    if (seen.has(key)) return;
    seen.add(key);
    counts.retraction = (counts.retraction || 0) + 1;
  });
  return { counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
}

function automatedPrioritySentence(stats) {
  const order = ["retraction", "expression_of_concern", "withdrawal", "removal"];
  const labels = {
    retraction: ["retractación", "retractaciones"],
    expression_of_concern: ["expresión de preocupación", "expresiones de preocupación"],
    withdrawal: ["retiro", "retiros"],
    removal: ["remoción", "remociones"],
    other: ["evento prioritario", "eventos prioritarios"]
  };
  const parts = [];
  [...order, ...Object.keys(stats.counts).filter(key => !order.includes(key))].forEach(key => {
    const count = stats.counts[key] || 0;
    if (!count) return;
    const pair = labels[key] || labels.other;
    parts.push(`${count} ${count === 1 ? pair[0] : pair[1]}`);
  });
  return `Se localizaron ${stats.total} evento${stats.total === 1 ? "" : "s"} editorial${stats.total === 1 ? "" : "es"} prioritario${stats.total === 1 ? "" : "s"}: ${joinSpanish(parts)}`;
}

function hasHistoricalWosData(detail) {
  return Array.isArray(detail?.incites) && detail.incites.some(item => item && item.year !== "" && item.year != null);
}

function hasFormalWosRemoval(detail) {
  const adverse = new Set(["Editorial De-listing", "Production De-listing", "Discontinuation", "Withdrawn"]);
  return Array.isArray(detail?.events) && detail.events.some(event =>
    event?.source === "WoS" && adverse.has(event.event_type_normalized || event.event_type)
  );
}

function wosNoLongerCurrent(journal, detail) {
  if (Number(journal.wos_historical_noncurrent) === 1) return true;
  return journal.wos_status !== "Current" && hasHistoricalWosData(detail) && !hasFormalWosRemoval(detail);
}

function wosHistoricalRange(detail, journal = null) {
  if (journal?.wos_historical_range) return journal.wos_historical_range;
  const years = (detail?.incites || [])
    .map(item => Number(item.year))
    .filter(Number.isFinite);
  return years.length ? `${Math.min(...years)}–${Math.max(...years)}` : "";
}

function wosSourceExtra(journal, detail) {
  const range = wosHistoricalRange(detail, journal);
  if (wosNoLongerCurrent(journal, detail)) {
    return range ? `Registros históricos en InCites: ${range}` : "Registros históricos identificados en InCites";
  }

  const parts = [];
  if (journal.wos_indexes) parts.push(`Índice(s): ${journal.wos_indexes}`);
  if (range) parts.push(`Cobertura registrada en InCites: ${range}`);
  return parts.join(" · ");
}

function indexingAlertTitle(scopusInactive, wosHistoricalAlert, doajWithdrawn) {
  if (scopusInactive && wosHistoricalAlert) return "Ya no figura como vigente en Scopus ni en Web of Science";
  if (scopusInactive) return "La revista aparece como inactiva en Scopus";
  if (wosHistoricalAlert) return "Ya no figura como vigente en Web of Science";
  if (doajWithdrawn) return "La revista fue retirada de DOAJ";
  return "Alerta de indexación";
}

function indexingAlertMeta(journal, detail) {
  const parts = [];
  if (journal.scopus_status === "Inactive") {
    parts.push(`<span><strong>Scopus:</strong> Inactiva${journal.scopus_coverage ? ` · Cobertura ${escapeHtml(journal.scopus_coverage)}` : ""}</span>`);
  }
  if (wosNoLongerCurrent(journal, detail)) {
    const range = wosHistoricalRange(detail, journal);
    parts.push(`<span><strong>Web of Science:</strong> Ya no vigente${range ? ` · Registros InCites ${escapeHtml(range)}` : ""}</span>`);
  }
  if (journal.doaj_status === "Withdrawn") parts.push("<span><strong>DOAJ:</strong> Retirada</span>");
  return parts.length ? `<div class="official-meta">${parts.join("")}</div>` : "";
}

function indexingAlertSummary(journal, detail, excludeFormalSources = false) {
  const statements = [];
  const formalSources = String(journal.official_sources || "");
  if (journal.scopus_status === "Inactive" && (!excludeFormalSources || !formalSources.includes("Scopus"))) statements.push("Scopus: inactiva");
  if (wosNoLongerCurrent(journal, detail) && (!excludeFormalSources || !formalSources.includes("WoS"))) statements.push("Web of Science: ya no figura como vigente");
  if (journal.doaj_status === "Withdrawn" && (!excludeFormalSources || !formalSources.includes("DOAJ"))) statements.push("DOAJ: retirada");
  return statements.length ? `<p class="additional-alert"><strong>Otras alertas de indexación:</strong> ${escapeHtml(statements.join("; "))}.</p>` : "";
}

function joinSpanish(items) {
  if (!items.length) return "presenta una alerta de indexación";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} y ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

function officialMeta(journal) {
  const parts = [];
  if (journal.official_sources) parts.push(`<span><strong>Fuente:</strong> ${escapeHtml(journal.official_sources.replaceAll("WoS", "Web of Science"))}</span>`);
  if (journal.official_event_years) parts.push(`<span><strong>Año(s):</strong> ${escapeHtml(journal.official_event_years)}</span>`);
  if (journal.official_reason_group) parts.push(`<span><strong>Motivo:</strong> ${escapeHtml(journal.official_reason_group)}</span>`);
  return parts.length ? `<div class="official-meta">${parts.join("")}</div>` : "";
}

function sourceRow(sourceClass, name, status, extra, url) {
  const tone = status.tone ? ` ${status.tone}` : "";
  const external = url ? `<a class="source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ver registro</a>` : "";
  return `
    <div class="source-row ${sourceClass}${tone}">
      <div class="source-name"><span class="source-dot"></span><strong>${escapeHtml(name)}</strong></div>
      <div class="source-state"><strong>${escapeHtml(status.label)}</strong>${extra ? `<span>${escapeHtml(extra)}</span>` : ""}</div>
      ${external}
    </div>`;
}

function scopusStatus(journal) {
  const currentRemoval = journal.official_status === "Current removal" && String(journal.official_sources || "").includes("Scopus");
  if (currentRemoval) return { label: "Retirada / desindexada en Scopus", tone: "removed" };
  if (journal.scopus_status === "Active") return { label: "Vigente en Scopus", tone: "active" };
  if (journal.scopus_status === "Inactive") return { label: "Inactiva en Scopus", tone: "removed" };
  return { label: "Revista no indexada en Scopus", tone: "absent" };
}

function wosStatus(journal, detail) {
  const currentRemoval = journal.official_status === "Current removal" && String(journal.official_sources || "").includes("WoS");
  if (currentRemoval || hasFormalWosRemoval(detail)) return { label: "Retirada / desindexada en Web of Science", tone: "removed" };
  if (journal.wos_status === "Current") return { label: "Vigente en Web of Science", tone: "active" };
  if (wosNoLongerCurrent(journal, detail)) return { label: "Ya no figura como vigente en Web of Science", tone: "removed" };
  return { label: "Revista no indexada en Web of Science", tone: "absent" };
}

function doajStatus(journal) {
  if (journal.doaj_status === "Current") return { label: "Vigente en DOAJ", tone: "active" };
  if (journal.doaj_status === "Current (withdrawal history)") return { label: "Vigente en DOAJ con antecedente de retiro", tone: "active" };
  if (journal.doaj_status === "Withdrawn") return { label: "Retirada en DOAJ", tone: "removed" };
  return { label: "Revista no indexada en DOAJ", tone: "absent" };
}

function inactiveWithoutEventNote(journal) {
  return "";
}

function quantLabel(status) {
  return ({
    "High alert": "Alerta alta",
    "Moderate alert": "Alerta moderada",
    "No quantitative signals": "Sin señales cuantitativas",
    "Limited data": "Evaluación limitada",
    "Not applicable": "Evaluación cuantitativa no disponible"
  })[status] || status || "No determinada";
}

function quantClass(status) {
  return ({
    "High alert": "high",
    "Moderate alert": "moderate",
    "No quantitative signals": "no-signals",
    "Limited data": "limited",
    "Not applicable": "not-applicable"
  })[status] || "not-applicable";
}

function sufficiencyLabel(value) {
  return value === "Sufficient" ? "Suficiente" : value === "Limited" ? "Limitada" : value || "No determinada";
}

function metricsHtml(journal, detail, availability = bibliometricSourceAvailability(journal, detail)) {
  const panels = [];
  if (availability.scimago) {
    panels.push(quantSourcePanel(
      "scimago",
      "Scopus / SCImago",
      "Indicadores calculados con series de SCImago, basadas en datos de Scopus.",
      [
        sourceProductionMetric(journal, detail, "scimago"),
        scimagoPersistenceMetric(journal, detail),
        scimagoSjrMetric(journal, detail),
        scimagoTrajectoryMetric(journal, detail)
      ]
    ));
  }
  if (availability.wos) {
    panels.push(quantSourcePanel(
      "wos",
      "Web of Science / InCites",
      "Indicadores obtenidos de las exportaciones de InCites. El JIF disponible se presenta como la principal métrica de revista; el CNCI y el JCI se conservan como indicadores complementarios.",
      [
        sourceProductionMetric(journal, detail, "incites"),
        jifMetric(journal),
        jifDependencyMetric(journal),
        selfCitationMetric(journal),
        cnciMetric(journal),
        jciMetric(journal)
      ]
    ));
  }
  if (!panels.length) return `<div class="quant-source-empty"><strong>Sin fuentes bibliométricas aplicables</strong><p>No se identificó cobertura actual o histórica en Scopus/SCImago ni en Web of Science/InCites.</p></div>`;
  const concordance = availability.scimago && availability.wos ? productionConcordanceHtml(journal) : "";
  return `<div class="quant-source-stack">${panels.join("")}</div>${concordance}`;
}

function quantSourcePanel(sourceClass, title, description, metrics) {
  return `<section class="quant-source-panel ${escapeHtml(sourceClass)}-panel">
    <div class="quant-source-heading"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div></div>
    <div class="metric-grid source-metric-grid">${metrics.map(metricCardHtml).join("")}</div>
  </section>`;
}

function metricCardHtml(metric) {
  const priorityClass = metric.priority ? " primary-metric" : "";
  return `<div class="metric ${escapeHtml(metric.tone || "normal")}${priorityClass}">
    <span>${escapeHtml(metric.label)}</span>
    <strong>${escapeHtml(metric.value)}</strong>
    <small>${escapeHtml(metric.note)}</small>
  </div>`;
}

function hasMetricValue(value) {
  return value !== "" && value != null && Number.isFinite(Number(value));
}

function signalTone(signal) {
  if (signal === "Extreme") return "high";
  if (signal === "Moderate") return "moderate";
  return "normal";
}

function metricSeriesContext(detail, source) {
  const isScimago = source === "scimago";
  const series = sourceSeriesValues(isScimago ? detail?.sjr : detail?.incites, isScimago ? "total_docs_year" : "wos_documents");
  const first = series[0];
  const latest = series.at(-1);
  return { series, first, latest, range: series.length ? `${first.year}–${latest.year}` : "" };
}

function sourceProductionMetric(journal, detail, source) {
  const isScimago = source === "scimago";
  const label = isScimago ? "Producción SCImago" : "Producción InCites";
  const current = isScimago ? journal.sjr_docs_2025 : journal.incites_docs_2025;
  const baseline = isScimago ? journal.sjr_docs_baseline_median : journal.incites_docs_baseline_median;
  const ratio = isScimago ? journal.sjr_production_ratio : journal.incites_production_ratio;
  const signal = isScimago ? journal.production_signal_scimago : journal.production_signal_incites;
  const context = metricSeriesContext(detail, source);
  if (!hasMetricValue(ratio)) {
    if (context.latest && Number(context.latest.year) < 2025) {
      return { label, value: "No evaluable en 2025", note: `Hay una serie histórica ${context.range}, pero la cobertura terminó antes del periodo actual.`, tone: "historical" };
    }
    if (context.series.length) {
      const reasons = [];
      if (context.series.filter(item => Number(item.year) >= 2020 && Number(item.year) <= 2024).length < 3) reasons.push("menos de tres años de línea base entre 2020 y 2024");
      if (hasMetricValue(current) && Number(current) < 50) reasons.push(`solo ${integerFormat(current)} documentos en 2025; se requieren 50`);
      if (hasMetricValue(baseline) && Number(baseline) < 20) reasons.push(`mediana histórica de ${numberFormat(baseline)}; se requieren 20`);
      return { label, value: "Información insuficiente para evaluar", note: reasons.length ? capitalize(reasons.join("; ")) : `Existe una serie ${context.range}, pero no cumple todos los mínimos metodológicos.`, tone: "limited" };
    }
    return { label, value: "Dato no reportado", note: "La fuente no aporta una serie anual de producción en los archivos integrados.", tone: "missing" };
  }
  const note = `2025: ${integerFormat(current)} · mediana 2020–2024: ${numberFormat(baseline)}`;
  if (signal === "Extreme") return { label, value: `${numberFormat(ratio)} veces`, note: `Crecimiento extremo · ${note}`, tone: "high" };
  if (signal === "Moderate") return { label, value: `${numberFormat(ratio)} veces`, note: `Crecimiento moderado · ${note}`, tone: "moderate" };
  return { label, value: `${numberFormat(ratio)} veces`, note: `Comparación disponible, sin crecimiento atípico · ${note}`, tone: "normal" };
}

function scimagoPersistenceMetric(journal, detail) {
  const years = Number(journal.production_persistent_years || 0);
  const status = journal.production_persistence_status || "";
  const context = metricSeriesContext(detail, "scimago");
  if (!status || status === "No comparable signal") {
    if (context.latest && Number(context.latest.year) < 2025) return { label: "Persistencia SCImago", value: "No evaluable en el periodo actual", note: `La serie disponible termina en ${context.latest.year}; no puede comprobarse persistencia reciente.`, tone: "historical" };
    if (context.series.length) return { label: "Persistencia SCImago", value: "Información insuficiente para evaluar", note: "La serie existe, pero no reúne las ventanas retrospectivas y los mínimos de volumen requeridos.", tone: "limited" };
    return { label: "Persistencia SCImago", value: "Dato no reportado", note: "No existe una serie anual SCImago vinculada a esta revista.", tone: "missing" };
  }
  if (years >= 2 || status === "Persistent growth") return { label: "Persistencia SCImago", value: `${years || 2} años`, note: "Crecimiento atípico observado en más de un año", tone: years >= 3 ? "high" : "moderate" };
  if (years === 1 || status === "Single-year signal") return { label: "Persistencia SCImago", value: "1 año", note: "Señal de un solo año; no se considera persistente", tone: "normal" };
  return { label: "Persistencia SCImago", value: "Sin persistencia", note: "No se detectó crecimiento atípico repetido", tone: "normal" };
}

function bestQuartile(series) {
  const quartiles = (series || []).map(item => String(item.quartile || "").toUpperCase()).filter(value => /^Q[1-4]$/.test(value));
  if (!quartiles.length) return "No reportado";
  return quartiles.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0];
}

function scimagoSjrMetric(journal, detail) {
  const series = sourceSeriesValues(detail?.sjr, "sjr");
  const latest = series.at(-1);
  const value = latest ? latest.sjr : (hasMetricValue(journal.sjr_2025) ? journal.sjr_2025 : journal.sjr);
  const year = latest?.year || (hasMetricValue(journal.sjr_2025) ? 2025 : journal.sjr_year || "");
  if (!hasMetricValue(value)) return { label: "SJR", value: "Dato no reportado", note: "SCImago no aporta un valor SJR para esta revista en los archivos integrados.", tone: "missing", priority: true };
  const peak = series.length ? series.reduce((best, item) => Number(item.sjr) > Number(best.sjr) ? item : best, series[0]) : null;
  const quartile = bestQuartile(series) !== "No reportado" ? bestQuartile(series) : (journal.sjr_quartile_2025 || journal.sjr_quartile || "No reportado");
  const peakText = peak ? ` · mejor valor: ${numberFormat(peak.sjr)} (${peak.year})` : "";
  return { label: `SJR ${year}`.trim(), value: numberFormat(value), note: `Mejor cuartil alcanzado: ${quartile}${peakText}`, tone: "normal", priority: true };
}

function scimagoTrajectoryMetric(journal, detail) {
  const ratio = journal.sjr_change_ratio;
  const absolute = journal.sjr_absolute_change;
  const signal = journal.sjr_trajectory_signal;
  const series = sourceSeriesValues(detail?.sjr, "sjr");
  if (!hasMetricValue(ratio)) {
    if (series.length >= 2) {
      const first = series[0];
      const latest = series.at(-1);
      const change = Number(first.sjr) !== 0 ? ((Number(latest.sjr) - Number(first.sjr)) / Number(first.sjr)) * 100 : null;
      const changeText = change == null ? "" : `${change >= 0 ? "+" : ""}${change.toFixed(1)} %`;
      return { label: "Trayectoria SJR", value: `${first.year}–${latest.year}`, note: `De ${numberFormat(first.sjr)} a ${numberFormat(latest.sjr)}${changeText ? ` (${changeText})` : ""}. La gráfica muestra cada año.`, tone: "historical" };
    }
    return { label: "Trayectoria SJR", value: "Información insuficiente para evaluar", note: "Se requiere más de un año con SJR para describir su evolución.", tone: "limited" };
  }
  const absText = hasMetricValue(absolute) ? ` · cambio absoluto: ${Number(absolute) >= 0 ? "+" : ""}${numberFormat(absolute)}` : "";
  if (signal === "Extreme") return { label: "Trayectoria SJR", value: `${numberFormat(ratio)} veces`, note: `Variación extrema frente a 2020–2024${absText}`, tone: "high" };
  if (signal === "Moderate") return { label: "Trayectoria SJR", value: `${numberFormat(ratio)} veces`, note: `Variación moderada frente a 2020–2024${absText}`, tone: "moderate" };
  return { label: "Trayectoria SJR", value: `${numberFormat(ratio)} veces`, note: `Comparación disponible, sin variación atípica${absText}`, tone: "normal" };
}

function selfCitationMetric(journal) {
  if (!hasMetricValue(journal.source_self_cite_share)) return { label: "Autocitación de la fuente", value: "Dato no reportado", note: "InCites no aporta los dos conteos necesarios para calcular la proporción de autocitación de la revista.", tone: "missing" };
  const confidenceLabels = { High: "alta", Moderate: "media", Limited: "limitada" };
  const confidence = journal.source_self_confidence ? ` · confianza ${confidenceLabels[journal.source_self_confidence] || String(journal.source_self_confidence).toLowerCase()}` : "";
  if (journal.source_self_signal === "Extreme") return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `${percentage(journal.source_self_cite_share)} de las citas registradas provienen de artículos publicados en la misma revista. Proporción muy alta; requiere revisión cualitativa.`, tone: "high" };
  if (journal.source_self_signal === "Moderate") return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `${percentage(journal.source_self_cite_share)} de las citas registradas provienen de artículos publicados en la misma revista. Proporción elevada; conviene revisarla.`, tone: "moderate" };
  return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `${percentage(journal.source_self_cite_share)} de las citas registradas provienen de artículos publicados en la misma revista. No se detectó una proporción atípica.`, tone: "normal" };
}

function cnciMetric(journal) {
  if (!hasMetricValue(journal.cnci_2024)) return { label: "CNCI documental (complementario)", value: "Dato no reportado", note: "InCites no aporta el CNCI de la cohorte evaluada para esta revista.", tone: "missing" };
  if (journal.cnci_signal === "Extreme") return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Variación extrema del impacto normalizado de los documentos; requiere revisión.", tone: "high" };
  if (journal.cnci_signal === "Moderate") return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Variación elevada del impacto normalizado de los documentos; requiere revisión.", tone: "moderate" };
  return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Impacto normalizado de los documentos, sin anomalía detectada. No sustituye al JIF.", tone: "normal" };
}

function jifMetric(journal) {
  if (!hasMetricValue(journal.jif_current)) return { label: "JIF", value: "Dato no reportado", note: "La revista tiene cobertura en Web of Science / InCites, pero la exportación integrada no reporta un JIF para este título.", tone: "missing", priority: true };
  return { label: "JIF disponible en InCites", value: numberFormat(journal.jif_current), note: `Cuartil JIF: ${journal.jif_quartile || "No reportado"}. Se muestra como valor de referencia de la revista; el periodo documental seleccionado no se interpreta como una serie histórica del JIF.`, tone: "normal", priority: true };
}

function jifDependencyMetric(journal) {
  if (!hasMetricValue(journal.jif_current)) return { label: "JIF sin autocitas", value: "Dato no reportado", note: "Sin un JIF disponible no puede evaluarse su diferencia respecto del valor sin autocitas.", tone: "missing" };
  if (!hasMetricValue(journal.jif_without_self) || !hasMetricValue(journal.jif_self_dependency)) {
    return { label: "JIF sin autocitas", value: "Información insuficiente para evaluar", note: "Existe un JIF disponible, pero falta el valor sin autocitas o alguno de los datos necesarios para medir la dependencia.", tone: "limited" };
  }
  const dependency = percentage(journal.jif_self_dependency);
  const explanation = `El JIF disminuye de ${numberFormat(journal.jif_current)} a ${numberFormat(journal.jif_without_self)} al excluir las autocitas. Esto indica que ${dependency} del JIF depende de citas provenientes de la propia revista.`;
  if (journal.jif_self_signal === "Extreme") return { label: "JIF sin autocitas", value: numberFormat(journal.jif_without_self), note: `${explanation} Dependencia muy alta; requiere revisión cualitativa.`, tone: "high" };
  if (journal.jif_self_signal === "Moderate") return { label: "JIF sin autocitas", value: numberFormat(journal.jif_without_self), note: `${explanation} Dependencia elevada; conviene revisarla.`, tone: "moderate" };
  return { label: "JIF sin autocitas", value: numberFormat(journal.jif_without_self), note: `${explanation} No se detectó una dependencia atípica.`, tone: "normal" };
}

function jciMetric(journal) {
  if (!hasMetricValue(journal.jci)) return { label: "JCI", value: "Dato no reportado", note: "El JCI no figura para esta revista en los archivos InCites integrados.", tone: "missing" };
  return { label: "JCI", value: numberFormat(journal.jci), note: `Cuartil JCI: ${journal.jci_quartile || "No reportado"}`, tone: "normal" };
}

function productionConcordanceHtml(journal) {
  const text = journal.production_concordance || "";
  if (!text || text === "No production signal") return "";
  const translations = {
    "SCImago + InCites": "La señal de producción coincide en SCImago e InCites.",
    "SCImago only": "La señal de producción aparece solo en SCImago.",
    "InCites only": "La señal de producción aparece solo en InCites.",
    "Both sources unavailable": "No existen datos comparables de producción en ninguna de las dos fuentes."
  };
  return `<div class="production-concordance"><strong>Comparación entre fuentes</strong><p>${escapeHtml(translations[text] || text)} Los valores no se promedian ni se sustituyen entre sí porque las coberturas son diferentes.</p></div>`;
}

function percentage(value) {
  return `${(Number(value) * 100).toFixed(1)} %`;
}

function numberFormat(value) {
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(Number(value));
}

function combinedTimelineEvents(detail, complementary) {
  const combined = [...(Array.isArray(detail?.events) ? detail.events : [])];
  const seen = new Set();
  (complementary?.crossref?.events || []).filter(item => item.severity === "high_signal").forEach(event => {
    const key = normalizeDoi(event.notice_doi || event.work_doi) || `${event.event_type}|${event.notice_title}|${event.notice_date}`;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push({
      source: event.metadata_source === "retraction-watch" ? "Retraction Watch / Crossref" : "Crossref",
      event_type: event.event_type,
      event_date: event.notice_date || "",
      title: event.notice_title || editorialEventLabel(event.event_type),
      reason: event.work_doi ? `Registro asociado: ${event.work_doi}` : "",
      automated_evidence: true
    });
  });
  (complementary?.openalex?.retracted_works || []).forEach(item => {
    const key = normalizeDoi(item.doi) || `openalex|${item.title}|${item.year}`;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push({
      source: "OpenAlex",
      event_type: "retraction",
      event_year: item.year || "",
      title: item.title || "Obra marcada como retractada",
      reason: item.doi ? `DOI: ${normalizeDoi(item.doi)}` : "",
      automated_evidence: true
    });
  });
  return combined;
}

function timelineHtml(events) {
  const ordered = [...events].sort((a, b) => eventValue(a) - eventValue(b));
  return `<div class="timeline">${ordered.map(event => {
    const source = event.source === "WoS" ? "Web of Science" : event.source;
    const rawSource = String(event.source || "").toLowerCase();
    const sourceClass = event.automated_evidence ? "evidence" : (event.source === "WoS" ? "wos" : rawSource);
    const eventType = event.event_type_normalized || event.event_type;
    const adverse = ["Discontinuation", "Editorial De-listing", "Production De-listing", "Withdrawn", "retraction", "expression_of_concern", "withdrawal", "removal"].includes(eventType);
    const reason = event.reason_normalized || event.reason || "";
    const description = event.automated_evidence ? reason : reasonSpanish(reason, eventType);
    return `
      <div class="timeline-event ${sourceClass} ${adverse ? "adverse" : ""}">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <span class="timeline-date">${escapeHtml(event.event_date || event.event_year || "Fecha no disponible")}</span>
          <h3>${escapeHtml(source)} · ${escapeHtml(eventLabel(eventType))}</h3>
          ${event.title ? `<p class="timeline-title">${escapeHtml(event.title)}</p>` : ""}
          ${description ? `<p>${escapeHtml(description)}${event.idx ? ` · Índice: ${escapeHtml(event.idx)}` : ""}</p>` : ""}
        </div>
      </div>`;
  }).join("")}</div>`;
}

function eventValue(event) {
  return Number(String(event.event_date || event.event_year || 0).replaceAll("-", "").slice(0, 8)) || 0;
}

function eventLabel(value) {
  return ({
    "Discontinuation": "Descontinuación",
    "Editorial De-listing": "Retiro editorial",
    "Production De-listing": "Retiro por producción",
    "Withdrawn": "Retiro",
    "Added": "Alta o reincorporación",
    "Accepted": "Aceptada",
    "Accepted pending": "Aceptación pendiente",
    "Title Change": "Cambio de título",
    "Cease": "Cese",
    "retraction": "Retractación",
    "expression_of_concern": "Expresión de preocupación",
    "withdrawal": "Retiro",
    "removal": "Remoción"
  })[value] || value;
}

function reasonSpanish(reason, type) {
  const translations = {
    "Journal not adhering to best practice": "La fuente reportó no adherencia a buenas prácticas.",
    "Website unavailable or invalid": "La fuente reportó un sitio web no disponible o inválido.",
    "Journal website URL is no longer available": "La fuente reportó que el sitio web ya no estaba disponible.",
    "Ceased publishing": "La fuente reportó cese de publicación.",
    "Journal has ceased publishing": "La fuente reportó cese de publicación.",
    "Journal is no longer open access": "La fuente reportó que dejó de cumplir la condición de acceso abierto."
  };
  if (reason) return translations[reason] || reason;
  if (type === "Discontinuation") return "Scopus registró la descontinuación.";
  if (type === "Editorial De-listing") return "Web of Science registró un retiro editorial.";
  if (type === "Production De-listing") return "Web of Science registró un retiro por producción.";
  return "";
}

function chartBlock(title, series, key, sourceClass, measureLabel = "documentos", options = {}) {
  const valid = sourceSeriesValues(series, key);
  if (!valid.length) return "";

  const width = 920;
  const height = 390;
  const padding = { left: 74, right: 34, top: 58, bottom: 64 };
  const values = valid.map(item => Number(item[key]));
  const maximum = Math.max(...values, 1);
  const xStep = valid.length > 1 ? (width - padding.left - padding.right) / (valid.length - 1) : 0;
  const chartHeight = height - padding.top - padding.bottom;
  const formatValue = value => options.decimals != null
    ? new Intl.NumberFormat("es-PE", { minimumFractionDigits: 0, maximumFractionDigits: options.decimals }).format(Number(value))
    : integerFormat(value);
  const points = valid.map((item, index) => {
    const x = valid.length > 1 ? padding.left + index * xStep : width / 2;
    const y = height - padding.bottom - (Number(item[key]) / maximum) * chartHeight;
    return { x, y, year: item.year, value: Number(item[key]), annotation: options.annotationKey ? item[options.annotationKey] : "" };
  });
  const polyline = points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const dots = points.map(point => `<circle tabindex="0" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6" aria-label="${escapeHtml(String(point.year))}: ${escapeHtml(formatValue(point.value))} ${escapeHtml(measureLabel)}"><title>${point.year}: ${formatValue(point.value)} ${measureLabel}${point.annotation ? ` · ${point.annotation}` : ""}</title></circle>`).join("");
  const showPointValues = options.showPointValues !== false && points.length <= 14;
  const pointValues = showPointValues ? points.map((point, index) => {
    const shift = index % 2 === 0 ? -14 : 22;
    const y = Math.max(18, point.y + shift);
    return `<text class="point-value" x="${point.x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escapeHtml(formatValue(point.value))}${point.annotation ? ` · ${escapeHtml(String(point.annotation))}` : ""}</text>`;
  }).join("") : "";
  const labelEvery = valid.length > 22 ? 3 : valid.length > 14 ? 2 : 1;
  const labels = points.map((point, index) => {
    const show = index === 0 || index === valid.length - 1 || index % labelEvery === 0;
    return show ? `<text x="${point.x.toFixed(1)}" y="${height - 22}" text-anchor="middle">${escapeHtml(String(point.year))}</text>` : "";
  }).join("");
  const gridLines = [0.25, 0.5, 0.75, 1].map(fraction => {
    const y = height - padding.bottom - fraction * chartHeight;
    const value = maximum * fraction;
    return `<line class="grid-line" x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}"></line><text class="axis-value" x="8" y="${(y + 4).toFixed(1)}">${escapeHtml(formatValue(value))}</text>`;
  }).join("");
  const latest = valid[valid.length - 1];
  const annotationHead = options.annotationKey ? `<th>${escapeHtml(options.annotationLabel || "Categoría")}</th>` : "";
  const annotationCells = item => options.annotationKey ? `<td>${escapeHtml(item[options.annotationKey] || "No reportado")}</td>` : "";

  return `<div class="chart-card ${sourceClass}">
    <div class="chart-card-heading"><h3>${escapeHtml(title)}</h3><span>${escapeHtml(String(latest.year))}: <strong>${escapeHtml(formatValue(latest[key]))}</strong>${options.annotationKey && latest[options.annotationKey] ? ` · ${escapeHtml(String(latest[options.annotationKey]))}` : ""}</span></div>
    <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}: ${escapeHtml(measureLabel)} por año">
      ${gridLines}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <text class="axis-value" x="42" y="${height - padding.bottom + 4}">0</text>
      <polyline class="series-line" points="${polyline}"></polyline>${dots}${pointValues}${labels}
    </svg></div>
    <p class="chart-help">Los valores se muestran sobre los puntos; pase el cursor para consultar el detalle.</p>
    <details class="chart-data"><summary>Ver datos anuales</summary><div class="chart-table-wrap"><table><thead><tr><th>Año</th><th>${escapeHtml(capitalize(measureLabel))}</th>${annotationHead}</tr></thead><tbody>${valid.map(item => `<tr><td>${escapeHtml(String(item.year))}</td><td>${escapeHtml(formatValue(item[key]))}</td>${annotationCells(item)}</tr>`).join("")}</tbody></table></div></details>
  </div>`;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function qualitativeHtml(journal) {
  if (journal.qualitative_review_status !== "Completed") {
    return `
      <div class="human-review-status pending">
        <span>Estado</span>
        <strong>No realizada</strong>
      </div>`;
  }

  return `
    <div class="human-review-status completed">
      <span>Resultado</span>
      <strong>${escapeHtml(qualitativeLabel(journal.qualitative_review_result))}</strong>
      ${journal.review_date ? `<small>Fecha de revisión: ${escapeHtml(journal.review_date)}</small>` : ""}
      ${journal.qualitative_summary ? `<p>${escapeHtml(journal.qualitative_summary)}</p>` : ""}
    </div>`;
}

function qualitativeLabel(value) {
  return ({
    "Observed": "Observada",
    "Monitor": "Seguimiento",
    "No additional alert": "Sin hallazgos adicionales"
  })[value] || value || "Realizada";
}

function openAlexSectionHtml(openalex) {
  if (!openalex || !openalex.source) return "";
  const source = openalex.source;
  const production = openalex.production_by_year || [];
  const hIndex = source.summary_stats?.h_index;
  const oaShare = openalex.oa_share == null ? "Sin dato" : `${openalex.oa_share} %`;
  const quality = openAlexQualityHtml(openalex.quality_flags || []);
  const openAlexUrl = source.id || "";
  const narrative = openAlexNarrative(production, openalex.oa_share);

  return `
    <section class="journal-section openalex-section">
      <div class="section-heading">
        <div><p class="section-kicker">Fuente bibliométrica abierta</p><h2>Análisis complementario con OpenAlex</h2></div>
      </div>
      <p class="openalex-intro">OpenAlex aporta una lectura adicional sobre producción, citación, acceso abierto y procedencia institucional. No sustituye el estado oficial de Scopus, Web of Science o DOAJ ni modifica por sí solo la escala de evaluación.</p>
      ${openAlexComplementaryEvaluationHtml(openalex)}
      <div class="openalex-metrics">
        ${openAlexMetric("Documentos registrados", integerFormat(source.works_count), "Total atribuido por OpenAlex")}
        ${openAlexMetric("Citas registradas", integerFormat(source.cited_by_count), "Conteo acumulado en OpenAlex")}
        ${openAlexMetric("Índice h", hIndex == null ? "Sin dato" : integerFormat(hIndex), "Indicador calculado por OpenAlex")}
        ${openAlexMetric("Producción en acceso abierto", oaShare, "Participación en la serie utilizada")}
      </div>
      ${narrative}
      <div class="charts-grid openalex-charts">
        ${chartBlock("Producción registrada en OpenAlex", production, "works_count", "openalex", "documentos")}
        ${chartBlock("Citas registradas en OpenAlex", production, "cited_by_count", "openalex-citations", "citas")}
      </div>
      ${quality}
      ${openAlexExplorerHtml(openalex.top || {})}
      <div class="openalex-source-note">
        <span><strong>Fuente:</strong> ${escapeHtml(source.display_name || "OpenAlex")}${source.host_organization_name ? ` · ${escapeHtml(source.host_organization_name)}` : ""}</span>
        ${source.updated_date ? `<span><strong>Actualización en OpenAlex:</strong> ${escapeHtml(formatDate(source.updated_date))}</span>` : ""}
        ${openAlexUrl ? `<a href="${escapeHtml(openAlexUrl)}" target="_blank" rel="noopener">Ver registro en OpenAlex</a>` : ""}
      </div>
    </section>`;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function openAlexComplementaryEvaluationHtml(openalex) {
  const series = sourceSeriesValues(openalex.production_by_year, "works_count");
  const baseline = series.filter(item => Number(item.year) >= 2020 && Number(item.year) <= 2024);
  const current = series.find(item => Number(item.year) === 2025);
  const baselineMedian = median(baseline.map(item => item.works_count));
  let productionMetric;
  if (current && baseline.length >= 3 && baselineMedian != null && baselineMedian >= 20 && Number(current.works_count) >= 50) {
    const ratio = Number(current.works_count) / baselineMedian;
    productionMetric = { label: "Producción OpenAlex 2025", value: `${numberFormat(ratio)} veces`, note: `2025: ${integerFormat(current.works_count)} · mediana 2020–2024: ${numberFormat(baselineMedian)}. Comparación descriptiva; aún no modifica la categoría pública.`, tone: "available" };
  } else if (series.length) {
    const range = `${series[0].year}–${series.at(-1).year}`;
    productionMetric = { label: "Producción OpenAlex", value: "Información insuficiente para evaluar", note: `Existe una serie ${range}, pero no cumple los mínimos de años o volumen para la comparación 2025.`, tone: "limited" };
  } else {
    productionMetric = { label: "Producción OpenAlex", value: "Dato no reportado", note: "OpenAlex no aporta una serie anual utilizable para esta fuente.", tone: "missing" };
  }

  const dimensions = [
    ["temas", openalex.top?.topics],
    ["países", openalex.top?.countries],
    ["instituciones", openalex.top?.institutions]
  ].filter(([, items]) => Array.isArray(items) && items.length);
  const metadataMetric = dimensions.length
    ? { label: "Metadatos enriquecidos", value: `${dimensions.length} de 3 dimensiones`, note: `Disponibles: ${dimensions.map(([name]) => name).join(", ")}.`, tone: "available" }
    : { label: "Metadatos enriquecidos", value: "Enriquecimiento pendiente", note: "El cruce básico está disponible, pero temas, países e instituciones aún no se han completado para esta revista.", tone: "limited" };

  const stableStart = openalex.stable_series_start || series[0]?.year;
  const seriesMetric = series.length
    ? { label: "Cobertura temporal OpenAlex", value: `${series.length} años con registros`, note: `${stableStart ? `Serie sostenida desde ${stableStart}. ` : ""}El año en curso se muestra, pero no se usa para comparar años completos.`, tone: "available" }
    : { label: "Cobertura temporal OpenAlex", value: "Dato no reportado", note: "No se identificó una secuencia anual de publicaciones.", tone: "missing" };

  const retractions = Array.isArray(openalex.retracted_works) ? openalex.retracted_works : [];
  const retractionMetric = retractions.length
    ? { label: "Obras marcadas como retractadas", value: integerFormat(retractions.length), note: "Son registros de detección que requieren verificación con la fuente editorial o una base especializada.", tone: "warning" }
    : { label: "Retracciones en OpenAlex", value: "Consulta exhaustiva pendiente", note: "La carga básica actual no consulta de forma exhaustiva todas las obras retractadas; no debe interpretarse como cero retractaciones.", tone: "pending" };

  const metrics = [productionMetric, seriesMetric, metadataMetric, retractionMetric];
  return `<div class="openalex-evaluation">
    <div class="openalex-evaluation-heading"><div><span>Evaluación complementaria inicial</span><strong>Indicadores descriptivos de OpenAlex</strong></div><em>No altera por sí sola la categoría cuantitativa</em></div>
    <div class="openalex-evaluation-grid">${metrics.map(item => `<div class="openalex-eval-card ${escapeHtml(item.tone)}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.note)}</small></div>`).join("")}</div>
  </div>`;
}

function openAlexMetric(label, value, note) {
  const valueText = String(value == null ? "" : value).trim();
  const availabilityClass = valueText && !/^sin dato$/i.test(valueText) ? "available" : "missing";
  return `<div class="openalex-metric ${availabilityClass}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function openAlexNarrative(series, oaShare) {
  const currentYear = new Date().getFullYear();
  const complete = (series || [])
    .filter(item => Number.isFinite(Number(item.year)) && Number.isFinite(Number(item.works_count)) && Number(item.year) <= currentYear - 1)
    .sort((a, b) => Number(a.year) - Number(b.year));
  if (!complete.length) return "";

  const peak = complete.reduce((best, item) => Number(item.works_count) > Number(best.works_count) ? item : best, complete[0]);
  const recent = complete.slice(-5);
  const previous = complete.slice(-10, -5);
  const recentAverage = recent.reduce((sum, item) => sum + Number(item.works_count), 0) / recent.length;
  const previousAverage = previous.length ? previous.reduce((sum, item) => sum + Number(item.works_count), 0) / previous.length : null;
  let trend = "";
  if (previousAverage && previousAverage > 0) {
    const change = ((recentAverage - previousAverage) / previousAverage) * 100;
    const direction = change > 5 ? "un aumento" : change < -5 ? "una disminución" : "una trayectoria estable";
    trend = ` En los cinco años completos más recientes, el promedio anual fue de ${integerFormat(Math.round(recentAverage))} documentos, frente a ${integerFormat(Math.round(previousAverage))} en los cinco años anteriores, lo que representa ${direction} (${change >= 0 ? "+" : ""}${change.toFixed(1)} %).`;
  }
  const oa = oaShare == null ? "" : ` La proporción de producción en acceso abierto registrada es de ${escapeHtml(String(oaShare))} %.`;
  return `<div class="openalex-narrative"><strong>Lectura de la tendencia</strong><p>La mayor producción anual de la serie se registró en ${escapeHtml(String(peak.year))}, con ${integerFormat(peak.works_count)} documentos.${trend}${oa} Las citas de los años más recientes deben interpretarse considerando su menor tiempo de acumulación.</p></div>`;
}

function openAlexQualityHtml(flags) {
  if (!flags.length) return "";
  const messages = flags.map(flag => {
    if (flag.code === "isolated_early_records") {
      return flag.stable_series_start
        ? `Se excluyeron de las gráficas registros aislados anteriores a ${flag.stable_series_start}, porque podían distorsionar la tendencia histórica.`
        : "Se excluyeron registros históricos aislados que podían distorsionar la tendencia.";
    }
    if (flag.code === "low_title_similarity") {
      return "El cruce se sostuvo por ISSN/eISSN, pero OpenAlex presenta una variante significativa en el título; el caso permanece bajo control de calidad.";
    }
    return flag.message || "El registro presenta una observación de control de calidad.";
  });
  return `<div class="openalex-quality"><strong>Control de calidad de los datos</strong><ul>${messages.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
}

function openAlexExplorerHtml(top) {
  const groups = [
    ["Temas", "Temas principales", top.topics || []],
    ["Países", "Países con mayor presencia", top.countries || []],
    ["Instituciones", "Instituciones con mayor presencia", top.institutions || []]
  ].filter(([, , items]) => items.length);
  if (!groups.length) return "";

  return `<div class="openalex-explorer">
    <div class="openalex-tabs" role="tablist" aria-label="Explorar datos complementarios de OpenAlex">
      ${groups.map(([key, title], index) => `<button type="button" role="tab" class="openalex-tab${index === 0 ? " active" : ""}" aria-selected="${index === 0}" data-openalex-tab="${escapeHtml(key)}">${escapeHtml(key)}</button>`).join("")}
    </div>
    <div class="openalex-tab-panels">
      ${groups.map(([key, title, items], index) => openAlexRankPanel(key, title, items, index === 0)).join("")}
    </div>
  </div>`;
}

function openAlexRankPanel(key, title, items, active) {
  const maximum = Math.max(...items.map(item => Number(item.count) || 0), 1);
  return `<section class="openalex-tab-panel" data-openalex-panel="${escapeHtml(key)}" ${active ? "" : "hidden"}>
    <h3>${escapeHtml(title)}</h3>
    <div class="openalex-rank-list">
      ${items.map((item, index) => {
        const width = Math.max(4, Math.round(((Number(item.count) || 0) / maximum) * 100));
        return `<div class="openalex-rank-item"><div class="openalex-rank-label"><span>${index + 1}. ${escapeHtml(item.name)}</span><strong>${integerFormat(item.count)}</strong></div><div class="openalex-rank-track"><span style="width:${width}%"></span></div></div>`;
      }).join("")}
    </div>
  </section>`;
}

function switchOpenAlexTab(button) {
  const explorer = button.closest(".openalex-explorer");
  if (!explorer) return;
  const key = button.dataset.openalexTab;
  explorer.querySelectorAll("[data-openalex-tab]").forEach(tab => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  explorer.querySelectorAll("[data-openalex-panel]").forEach(panel => {
    panel.hidden = panel.dataset.openalexPanel !== key;
  });
}

function automatedQualitativeSectionHtml(complementary, detail) {
  const evidence = collectAutomatedFindings(complementary, detail);
  let content = "";

  if (!complementary) {
    content = `<div class="automated-status not-run"><span>Estado</span><strong>No ejecutada</strong></div>`;
  } else if (!evidence.length) {
    content = `<div class="automated-status no-results"><span>Resultado</span><strong>Sin resultados relevantes</strong></div>`;
  } else {
    const stats = automatedPriorityStats(complementary);
    const visible = evidence.slice(0, 4);
    const extra = evidence.slice(4);
    content = `
      <div class="automated-narrative high">
        <h3>${escapeHtml(automatedPrioritySentence(stats))}</h3>
        <p>${escapeHtml(automatedEvidenceExplanation(stats))}</p>
        <p class="automated-caveat">La información no es concluyente a favor ni en contra de toda la revista. Su finalidad es aportar contexto verificable para una decisión editorial o académica mejor informada.</p>
      </div>
      <div class="automated-findings">${visible.map(automatedFindingCardHtml).join("")}${extra.length ? `<details class="automated-more"><summary>Ver ${extra.length} hallazgo(s) adicional(es)</summary><div>${extra.map(automatedFindingCardHtml).join("")}</div></details>` : ""}</div>`;
  }

  return `<section class="journal-section qualitative-automated-section">
    <div class="section-heading">
      <div><p class="section-kicker">Revisión automatizada de fuentes externas</p><h2>Evaluación cualitativa automatizada</h2></div>
    </div>
    ${content}
  </section>`;
}

function automatedEvidenceExplanation(stats) {
  const parts = [];
  if (stats.counts.retraction) parts.push("Las retractaciones indican que uno o más artículos fueron retirados del registro científico por problemas suficientemente relevantes como para invalidar o cuestionar su publicación; deben revisarse sus causas, concentración temporal y respuesta editorial.");
  if (stats.counts.expression_of_concern) parts.push("Las expresiones de preocupación comunican dudas formales sobre trabajos publicados mientras se completa o documenta una investigación.");
  if (stats.counts.withdrawal || stats.counts.removal) parts.push("Los retiros o remociones muestran que determinados registros dejaron de considerarse válidos o disponibles en su forma original.");
  return parts.join(" ") || "Los eventos localizados requieren revisión de su contexto y de la respuesta editorial de la revista.";
}

function collectAutomatedFindings(complementary, detail) {
  if (!complementary) return [];
  const findings = [];
  const seenDois = new Set();
  const crossrefEvents = (complementary.crossref?.events || []).filter(item => item.severity === "high_signal");

  crossrefEvents.forEach(event => {
    const doi = normalizeDoi(event.work_doi || event.notice_doi);
    if (doi) seenDois.add(doi);
    findings.push({
      tone: "high",
      type: editorialEventLabel(event.event_type),
      title: event.notice_title || editorialEventLabel(event.event_type),
      date: event.notice_date || "",
      source: event.metadata_source === "retraction-watch" ? "Retraction Watch / Crossref" : "Crossref",
      url: safeDoiUrl(event.notice_url || event.notice_doi),
      detail: event.work_doi ? `Registro asociado: ${event.work_doi}` : ""
    });
  });

  (complementary.openalex?.retracted_works || []).forEach(item => {
    const doi = normalizeDoi(item.doi);
    if (doi && seenDois.has(doi)) return;
    if (doi) seenDois.add(doi);
    findings.push({
      tone: "high",
      type: "Obra marcada como retractada",
      title: item.title || "Obra retractada",
      date: item.year ? String(item.year) : "",
      source: "OpenAlex",
      url: safeDoiUrl(item.doi),
      detail: item.cited_by_count != null ? `${integerFormat(item.cited_by_count)} citas registradas en OpenAlex` : ""
    });
  });

  return findings;
}

function automatedFindingCardHtml(finding) {
  return `<article class="automated-finding ${escapeHtml(finding.tone || "informational")}">
    <div class="finding-type">${escapeHtml(finding.type || "Hallazgo")}</div>
    <h3>${escapeHtml(finding.title || "Sin título")}</h3>
    <dl>
      ${finding.date ? `<div><dt>Fecha</dt><dd>${escapeHtml(finding.date)}</dd></div>` : ""}
      <div><dt>Fuente</dt><dd>${escapeHtml(finding.source || "Fuente no especificada")}</dd></div>
      ${finding.detail ? `<div><dt>Detalle</dt><dd>${escapeHtml(finding.detail)}</dd></div>` : ""}
    </dl>
    ${finding.url ? `<a class="finding-link" href="${escapeHtml(finding.url)}" target="_blank" rel="noopener">Ver fuente</a>` : ""}
  </article>`;
}

function normalizeDoi(value) {
  return String(value || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
}

function editorialEventLabel(value) {
  return ({
    retraction: "Retractación",
    expression_of_concern: "Expresión de preocupación",
    withdrawal: "Retiro",
    removal: "Remoción",
    correction: "Corrección",
    erratum: "Errata",
    corrigendum: "Corrigenda",
    addendum: "Adenda"
  })[value] || value || "Evento editorial";
}

function webCategoryLabel(value) {
  return ({
    ethics: "ética editorial",
    peer_review: "revisión por pares",
    fees_apc: "cargos y APC",
    editorial_board: "comité editorial",
    contact: "información de contacto",
    preservation: "preservación digital",
    retractions: "retractaciones y correcciones"
  })[value] || value;
}

function webStatusExplanation(status) {
  return ({
    blocked_by_robots: "El sitio restringió la consulta automatizada mediante robots.txt.",
    challenge_or_invalid_page: "El sitio devolvió una página de desafío, bloqueo o error en lugar del contenido editorial.",
    http_error: "El servidor denegó o interrumpió el acceso automatizado.",
    no_safe_homepage: "No se encontró una dirección web segura y utilizable para la consulta.",
    error: "Se produjo un error técnico durante la consulta automatizada."
  })[status] || "No fue posible recuperar información editorial utilizable mediante la consulta automatizada.";
}

function safeDoiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://doi.org/${raw.replace(/^doi:\s*/i, "")}`;
}

function integerFormat(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Sin dato";
  return new Intl.NumberFormat("es-PE", { maximumFractionDigits: 0 }).format(number);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("es-PE", { year: "numeric", month: "short", day: "2-digit" }).format(date);
}

async function copyJournalLink(journalId) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("j", journalId);
  try {
    await navigator.clipboard.writeText(url.toString());
    const button = document.querySelector(`[data-copy-journal="${CSS.escape(journalId)}"]`);
    if (button) {
      const original = button.textContent;
      button.textContent = "Enlace copiado";
      setTimeout(() => button.textContent = original, 1800);
    }
  } catch (error) {
    prompt("Copie este enlace:", url.toString());
  }
}

function highlight(value, query) {
  let output = escapeHtml(value);
  for (const token of normalize(query).split(/\s+/).filter(Boolean)) {
    output = output.replace(new RegExp(`(${escapeRegExp(token)})`, "ig"), "<mark>$1</mark>");
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
