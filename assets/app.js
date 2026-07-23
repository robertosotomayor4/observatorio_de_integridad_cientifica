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
  humanReviews: null,
  humanReviewsPromise: null,
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
    const [payload, complementary, humanReviews] = await Promise.all([
      loadDetailChunk(journal.detail_chunk),
      loadComplementaryForJournal(journal),
      loadHumanReviews()
    ]);
    const detail = payload.journals[journal.journal_id] || { events: [], sjr: [], incites: [], sources: [] };
    const humanReview = humanReviews[journal.journal_id] || null;
    $.journalContent.innerHTML = journalHtml(journal, detail, complementary, humanReview);
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


async function loadHumanReviews() {
  if (STATE.humanReviews) return STATE.humanReviews;
  if (STATE.humanReviewsPromise) return STATE.humanReviewsPromise;

  STATE.humanReviewsPromise = (async () => {
    try {
      const response = await fetch("data/human_reviews.json");
      if (!response.ok) throw new Error("human-reviews-json");
      const payload = await response.json();
      STATE.humanReviews = payload.records || {};
      return STATE.humanReviews;
    } catch (error) {
      console.warn("No se cargaron las revisiones cualitativas humanas.", error);
      STATE.humanReviews = {};
      return STATE.humanReviews;
    }
  })();

  return STATE.humanReviewsPromise;
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

function journalHtml(journal, detail, complementary, humanReviewRecord) {
  const publicTitle = publicJournalTitle(journal.preferred_title);
  const timelineEvents = combinedTimelineEvents(journal, detail, complementary);
  const hasEvents = timelineEvents.length > 0;
  const displayQuantStatus = effectiveQuantitativeStatus(journal, detail);
  const quantScope = quantitativeEvaluationScope(journal, detail);
  const humanReview = applyLocalHumanReviewDemo(effectiveHumanReview(journal, humanReviewRecord));
  const officialSection = evaluationSummaryHtml(journal, detail, complementary, humanReview);
  const sourceAvailability = bibliometricSourceAvailability(journal, detail);
  const productionHistory = productionHistoryHtml(journal, detail, sourceAvailability);
  const impactHistory = impactHistoryHtml(journal, detail, sourceAvailability);
  const coverageSeriesNote = coverageSeriesStartNote(journal, detail);
  const timelineSection = hasEvents ? `
    <section class="journal-section timeline-section">
      <div class="section-heading">
        <div><p class="section-kicker">Historia documentada</p><h2>Cronología de eventos relevantes</h2></div>
      </div>
      <p class="timeline-intro">Reúne inicios y finales de cobertura, cambios de estado, reincorporaciones y otros eventos editoriales documentados en las fuentes consultadas.</p>
      ${timelineHtml(timelineEvents)}
      ${coverageSeriesNote}
    </section>` : "";

  return `
    <article class="journal-sheet" id="${escapeHtml(journal.journal_id)}">
      <header class="journal-sheet-header">
        <div class="journal-heading-main">
          <div>
            <p class="sheet-kicker">Revista seleccionada</p>
            <h1>${escapeHtml(publicTitle)}</h1>
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
          ${sourceRow("scopus", "Scopus / SCImago", scopusStatus(journal), journal.scopus_coverage ? `Cobertura registrada: ${formatCoverageDisplay(journal.scopus_coverage)}` : "", "")}
          ${sourceRow("wos", "Web of Science / InCites", wosStatus(journal, detail), wosSourceExtra(journal, detail), "")}
          ${sourceRow("doaj", "DOAJ", doajStatus(journal), "", journal.doaj_url)}
        </div>
        ${inactiveWithoutEventNote(journal)}
      </section>

      ${timelineSection}

      <section class="journal-section quantitative-section">
        <div class="section-heading">
          <div><p class="section-kicker">Análisis bibliométrico</p><h2>Evaluación cuantitativa</h2></div>
          <span class="quant-badge ${quantClass(displayQuantStatus)}">${escapeHtml(detailedQuantitativeLabel(journal, detail))}</span>
        </div>
        <div class="quant-summary">
          <div>
            <span class="label">Alcance de los datos</span>
            <strong>${escapeHtml(quantScope.label)}</strong>
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

      ${openAlexSectionHtml(complementary?.openalex, journal, detail)}

      <section class="journal-section qualitative-human-section">
        <div class="section-heading">
          <div><p class="section-kicker">Revisión especializada</p><h2>Evaluación cualitativa humana</h2></div>
          ${humanReviewSectionBadge(humanReview)}
        </div>
        ${qualitativeHtml(humanReview)}
      </section>

      ${automatedQualitativeSectionHtml(complementary, detail)}

      <aside class="interpretation-note">
        <strong>Interpretación responsable</strong>
        <p>La ausencia de señales cuantitativas no garantiza integridad. Una señal cuantitativa o un hallazgo cualitativo no demuestra por sí solo una mala práctica. El resultado debe interpretarse junto con los hechos oficiales, el alcance de los datos y las evidencias documentadas.</p>
      </aside>

      <div class="sheet-actions">
        <button type="button" class="secondary-button" data-copy-journal="${escapeHtml(journal.journal_id)}">Copiar enlace de esta ficha</button>
        <a href="#searchSection">Realizar otra búsqueda</a>
      </div>
    </article>
  `;
}

function publicJournalTitle(value) {
  const title = String(value || "");
  const overrides = {
    "Boletin de Malariologia y Salud Ambiental": "Boletín de Malariología y Salud Ambiental"
  };
  return overrides[title] || title;
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

function productionHistoryHtml(journal, detail, availability) {
  const charts = [];
  const readings = [];
  let endedCoverage = false;
  if (availability.scimago) {
    const series = productionSeriesForSource(journal, detail, "scimago");
    if (series.length) {
      readings.push(sourceProductionReadingHtml(journal, detail, "scimago"));
      charts.push(chartBlock("SCImago / Scopus", series, "total_docs_year", "scopus", "documentos", { showPointValues: true }));
      endedCoverage = endedCoverage || sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "scimago");
    }
  }
  if (availability.wos) {
    const series = productionSeriesForSource(journal, detail, "incites");
    if (series.length) {
      readings.push(sourceProductionReadingHtml(journal, detail, "incites"));
      charts.push(chartBlock("InCites / Web of Science", series, "wos_documents", "wos", "documentos", { showPointValues: true }));
      endedCoverage = endedCoverage || sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "incites");
    }
  }
  if (!charts.length) return "";
  return `<section class="journal-section history-section">
    <div class="section-heading"><div><p class="section-kicker">Información histórica disponible</p><h2>Evolución de la producción</h2></div></div>
    <div class="source-readings-grid ${readings.length === 1 ? "single-source" : ""}">${readings.join("")}</div>
    <div class="charts-grid adaptive-charts ${charts.length === 1 ? "single-source" : ""}">${charts.join("")}</div>
    ${endedCoverage ? `<p class="history-note">Los años posteriores al fin de la cobertura no se representan como producción cero. La trayectoria se limita al periodo efectivamente registrado por cada fuente.</p>` : ""}
  </section>`;
}

function sourceProductionReadingHtml(journal, detail, source) {
  const isScimago = source === "scimago";
  const series = productionSeriesForSource(journal, detail, source);
  const key = isScimago ? "total_docs_year" : "wos_documents";
  const label = isScimago ? "Lectura de Scopus / SCImago" : "Lectura de Web of Science / InCites";
  const css = isScimago ? "scopus" : "wos";
  if (!series.length) return "";
  const peak = series.reduce((best, item) => Number(item[key]) > Number(best[key]) ? item : best, series[0]);
  const latest = series.at(-1);
  const ended = sourceCoverageEndedBeforeCurrentPeriod(journal, detail, source);
  let text = "";
  if (ended) {
    text = `La mayor producción registrada fue de ${integerFormat(peak[key])} documentos en ${peak.year}. El último año disponible es ${latest.year}, con ${integerFormat(latest[key])} documentos. La cobertura disponible termina en ${latest.year}; por ello, los años posteriores no se interpretan como producción cero ni se utilizan para evaluar una tendencia actual.`;
  } else if (series.length >= 2) {
    const previous = series.at(-2);
    const difference = Number(latest[key]) - Number(previous[key]);
    const change = Number(previous[key]) ? (difference / Number(previous[key])) * 100 : null;
    const direction = difference > 0 ? "aumentó" : difference < 0 ? "disminuyó" : "se mantuvo estable";
    text = `La producción ${direction} de ${integerFormat(previous[key])} documentos en ${previous.year} a ${integerFormat(latest[key])} en ${latest.year}${change == null ? "" : ` (${change >= 0 ? "+" : ""}${change.toFixed(1)} %)`}.`;
    const baseline = isScimago ? journal.sjr_docs_baseline_median : journal.incites_docs_baseline_median;
    const ratio = isScimago ? journal.sjr_production_ratio : journal.incites_production_ratio;
    const signal = isScimago ? journal.production_signal_scimago : journal.production_signal_incites;
    if (hasMetricValue(baseline) && hasMetricValue(ratio)) {
      const baselineChange = (Number(ratio) - 1) * 100;
      const atypical = signal === "Extreme" ? "representa un crecimiento extremo" : signal === "Moderate" ? "representa un crecimiento moderado" : "no representa una variación atípica";
      text += ` El valor de ${latest.year} está ${Math.abs(baselineChange).toFixed(1)} % ${baselineChange >= 0 ? "por encima" : "por debajo"} de la mediana 2020–2024 (${numberFormat(baseline)}) y ${atypical}.`;
    }
  } else {
    text = `Solo se dispone de ${integerFormat(latest[key])} documentos para ${latest.year}; no es posible describir una tendencia.`;
  }
  if (!isScimago && series.length < 3) text += " La serie es demasiado corta para establecer una tendencia reciente.";
  return `<div class="source-reading ${css}"><strong>${escapeHtml(label)}</strong><p>${escapeHtml(text)}</p></div>`;
}

function impactHistoryHtml(journal, detail, availability) {
  const sjrSeries = availability.scimago ? sourceSeriesValues(detail?.sjr, "sjr") : [];
  if (!sjrSeries.length) return "";
  const coverageEnd = sourceCoverageEnd(journal, detail, "scimago");
  const inCoverage = coverageEnd ? sjrSeries.filter(item => Number(item.year) <= coverageEnd) : sjrSeries;
  const reference = inCoverage.length ? inCoverage.at(-1) : sjrSeries.at(-1);
  const hasPostCoverage = Boolean(coverageEnd && sjrSeries.some(item => Number(item.year) > coverageEnd));
  const chart = chartBlock("Evolución histórica del SJR / SCImago", detail.sjr || [], "sjr", "scopus", "SJR", { decimals: 3, showPointValues: true, annotationKey: "quartile", annotationLabel: "Cuartil", coverageEnd: hasPostCoverage ? coverageEnd : null, headlineItem: reference });
  return `<section class="journal-section impact-history-section">
    <div class="section-heading"><div><p class="section-kicker">Trayectoria del impacto de la revista</p><h2>Evolución histórica del SJR</h2></div></div>
    ${scimagoImpactReadingHtml(journal, detail)}
    <div class="charts-grid adaptive-charts single-source">${chart}</div>
    ${hasPostCoverage ? `<p class="history-note">El SJR puede seguir apareciendo después del último año de cobertura porque refleja citas a documentos anteriores. Esos valores se conservan como información histórica, pero no implican que la revista continúe indexada.</p>` : ""}
  </section>`;
}

function scimagoImpactReadingHtml(journal, detail) {
  const series = sourceSeriesValues(detail?.sjr, "sjr");
  if (!series.length) return "";
  const coverageEnd = sourceCoverageEnd(journal, detail, "scimago");
  const inCoverage = coverageEnd ? series.filter(item => Number(item.year) <= coverageEnd) : series;
  const usable = inCoverage.length ? inCoverage : series;
  const latest = usable.at(-1);
  const peak = usable.reduce((best, item) => Number(item.sjr) > Number(best.sjr) ? item : best, usable[0]);
  const best = bestQuartile(usable);
  const ended = sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "scimago");
  let text = `En la serie disponible, el SJR osciló entre ${numberFormat(Math.min(...usable.map(item => Number(item.sjr))))} y ${numberFormat(peak.sjr)}. El mejor cuartil alcanzado fue ${best} en ${peak.year}.`;
  text += ended
    ? ` El último SJR correspondiente al periodo de cobertura fue ${numberFormat(latest.sjr)} (${latest.quartile || "cuartil no reportado"}) en ${latest.year}.`
    : ` El valor más reciente es ${numberFormat(latest.sjr)} (${latest.quartile || "cuartil no reportado"}) en ${latest.year}.`;
  if (coverageEnd && series.some(item => Number(item.year) > coverageEnd)) text += " Los valores posteriores se muestran de forma diferenciada y no representan cobertura vigente.";
  return `<div class="source-reading scopus impact-reading"><strong>Lectura de la trayectoria del SJR</strong><p>${escapeHtml(text)}</p></div>`;
}

function quantitativeMetricSet(journal, detail) {
  const availability = bibliometricSourceAvailability(journal, detail);
  const metrics = [];
  if (availability.scimago) {
    metrics.push(
      sourceProductionMetric(journal, detail, "scimago"),
      scimagoPersistenceMetric(journal, detail),
      scimagoSjrMetric(journal, detail),
      scimagoTrajectoryMetric(journal, detail)
    );
  }
  if (availability.wos) {
    metrics.push(
      sourceProductionMetric(journal, detail, "incites"),
      jifMetric(journal),
      jifDependencyMetric(journal),
      selfCitationMetric(journal),
      cnciMetric(journal),
      jciMetric(journal)
    );
  }
  return metrics;
}

function quantitativeEvaluationScope(journal, detail) {
  const status = effectiveQuantitativeStatus(journal, detail);
  const metrics = quantitativeMetricSet(journal, detail);
  const unavailable = metrics.filter(item => ["limited", "missing"].includes(item?.tone));
  const evaluated = metrics.filter(item => item && !["limited", "missing"].includes(item.tone));
  const partial = status === "No quantitative signals" && unavailable.length > 0 && evaluated.length > 0;
  if (status === "Limited data") return { label: "Evaluación limitada", partial: true, unavailable, evaluated };
  if (status === "Not applicable") return { label: "Evaluación cuantitativa no disponible", partial: true, unavailable, evaluated };
  if (partial) return { label: "Evaluación parcial disponible", partial: true, unavailable, evaluated };
  if (status === "No quantitative signals") return { label: "Datos suficientes para la evaluación", partial: false, unavailable, evaluated };
  return { label: "Datos disponibles para la evaluación", partial: unavailable.length > 0, unavailable, evaluated };
}

function publicQuantitativeLabel(journal, detail) {
  const status = effectiveQuantitativeStatus(journal, detail);
  const scope = quantitativeEvaluationScope(journal, detail);
  if (status === "No quantitative signals" && scope.partial) return "Sin señales en los indicadores evaluables";
  return quantLabel(status);
}

function detailedQuantitativeLabel(journal, detail) {
  const status = effectiveQuantitativeStatus(journal, detail);
  if (status === "No quantitative signals") return "Sin señales en los indicadores evaluables";
  return publicQuantitativeLabel(journal, detail);
}

function quantitativeInterpretation(journal, detail) {
  const status = effectiveQuantitativeStatus(journal, detail);
  const availability = bibliometricSourceAvailability(journal, detail);
  const scope = quantitativeEvaluationScope(journal, detail);
  if (status === "Limited data") {
    const parts = [];
    if (availability.scimago) {
      const context = metricSeriesContext(journal, detail, "scimago");
      if (context.latest && sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "scimago")) {
        parts.push(`Scopus/SCImago dispone de información hasta ${context.latest.year}, pero la cobertura terminó antes del periodo de evaluación 2025`);
      } else if (!hasMetricValue(journal.sjr_production_ratio)) {
        parts.push("Scopus/SCImago no reúne los años o el volumen mínimo para calcular crecimiento reciente");
      }
    }
    if (availability.wos) {
      const context = metricSeriesContext(journal, detail, "incites");
      if (context.latest && sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "incites")) {
        parts.push(`Web of Science/InCites dispone de información hasta ${context.latest.year}, pero no de una serie reciente evaluable`);
      } else if (!hasMetricValue(journal.incites_production_ratio)) {
        parts.push("Web of Science/InCites no reúne todos los mínimos para evaluar crecimiento reciente");
      }
    }
    if (parts.length) return `${parts.join(". ")}. Los datos existentes permiten describir la trayectoria histórica, pero no aplicar todos los criterios cuantitativos actuales.`;
    return "Existe información bibliométrica parcial, pero no alcanza los mínimos de años, continuidad o volumen requeridos para una evaluación cuantitativa completa.";
  }
  if (status === "No quantitative signals") {
    if (scope.partial) {
      const names = scope.unavailable.map(item => String(item.label || "").toLowerCase()).filter(Boolean);
      const unavailableText = names.length ? ` No fue posible evaluar: ${joinSpanish(names)}.` : "";
      return `Los datos disponibles permiten aplicar una evaluación cuantitativa parcial.${unavailableText} En los indicadores evaluables no se identificaron anomalías cuantitativas relevantes. Este resultado no equivale a una certificación de calidad o integridad editorial.`;
    }
    return "La serie disponible cumple los mínimos definidos para los indicadores aplicables. No se identificaron anomalías cuantitativas relevantes. Este resultado no equivale a una certificación de calidad o integridad editorial.";
  }
  if (status === "Moderate alert") return "Se identificaron patrones cuantitativos que justifican una revisión cualitativa antes de formular una conclusión más amplia.";
  if (status === "High alert") return "Se identificaron patrones cuantitativos fuertes o combinados que requieren una revisión cualitativa prioritaria.";
  return "No se dispone de información suficiente para aplicar la evaluación cuantitativa.";
}

function evaluationSummaryHtml(journal, detail, complementary, humanReview) {
  const scopusInactive = journal.scopus_status === "Inactive";
  const wosHistoricalAlert = wosNoLongerCurrent(journal, detail);
  const doajWithdrawn = journal.doaj_status === "Withdrawn";
  const autoStats = automatedPriorityStats(complementary);
  const quantStatus = effectiveQuantitativeStatus(journal, detail);
  const observed = humanReview?.status === "Culminada" && humanReview?.result === "Observada";
  const noFindings = humanReview?.status === "Culminada" && humanReview?.result === "Sin hallazgos";
  const signals = summarySignalsHtml(complementary, autoStats, quantStatus, humanReview, journal, detail);

  if (journal.official_status === "Current removal") {
    const additional = indexingAlertSummary(journal, detail, true);
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Retirada / desindexada</h2><p>Se registró un retiro o una desindexación oficial vigente en al menos una de las fuentes integradas.</p>${officialMeta(journal)}${additional}${signals}</div>
      </section>`;
  }

  if (journal.official_status === "Historical removal") {
    return `
      <section class="official-banner historical">
        <div class="official-icon">↺</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Antecedente histórico de retiro</h2><p>La revista presenta un retiro histórico documentado y un estado posterior que debe interpretarse junto con la cronología disponible.</p>${officialMeta(journal)}${signals}</div>
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
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>${escapeHtml(title)}</h2><p>La revista ${escapeHtml(joinSpanish(statements))}. Para fines de selección editorial, este resultado debe interpretarse como una señal de alerta.</p>${indexingAlertMeta(journal, detail)}${signals}</div>
      </section>`;
  }

  if (observed) {
    return `
      <section class="official-banner removal integrated-summary observed">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Revista observada</h2><p>${escapeHtml(integratedObservedSummary(journal, detail, complementary, autoStats, quantStatus))}</p>${signals}</div>
      </section>`;
  }

  if (autoStats.total > 0) {
    return `
      <section class="official-banner removal">
        <div class="official-icon">!</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Hallazgos editoriales que requieren revisión</h2><p>${escapeHtml(automatedPrioritySentence(autoStats))} Estos hallazgos aportan información relevante para la toma de decisiones, pero no permiten concluir por sí solos sobre la calidad o integridad global de la revista.</p>${signals}</div>
      </section>`;
  }

  if (quantStatus === "High alert" || quantStatus === "Moderate alert") {
    const high = quantStatus === "High alert";
    return `
      <section class="official-banner ${high ? "removal" : "moderate"}">
        <div class="official-icon">${high ? "!" : "i"}</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>${high ? "Alerta cuantitativa alta" : "Se requiere revisión adicional"}</h2><p>${escapeHtml(quantitativeInterpretation(journal, detail))}</p>${signals}</div>
      </section>`;
  }

  if (noFindings) {
    return `
      <section class="official-banner positive integrated-summary">
        <div class="official-icon">✓</div>
        <div><p class="section-kicker">Resumen de la evaluación</p><h2>Sin hallazgos en la revisión humana</h2><p>La revisión cualitativa humana no identificó hallazgos. Esta conclusión debe leerse junto con el estado de indexación, la evaluación cuantitativa y las consultas automatizadas.</p>${signals}</div>
      </section>`;
  }

  return `
    <section class="official-banner neutral integrated-summary">
      <div class="official-icon">i</div>
      <div><p class="section-kicker">Resumen de la evaluación</p><h2>Sin alertas oficiales documentadas</h2><p>No se identificaron retiros, desindexaciones u otros cambios adversos documentados en las fuentes integradas.</p>${signals}</div>
    </section>`;
}

function integratedObservedSummary(journal, detail, complementary, autoStats, quantStatus) {
  const parts = [];
  const sourceText = sourceOverviewSentence(journal, detail);
  if (sourceText) parts.push(sourceText);
  if (quantStatus === "No quantitative signals") parts.push("No se identificaron señales cuantitativas relevantes.");
  else if (quantStatus === "High alert") parts.push("La evaluación cuantitativa presenta una alerta alta.");
  else if (quantStatus === "Moderate alert") parts.push("La evaluación cuantitativa presenta una alerta moderada.");
  else if (quantStatus === "Limited data") parts.push("La evaluación cuantitativa es limitada por la disponibilidad de datos.");
  else parts.push("La evaluación cuantitativa no está disponible.");
  parts.push("La revisión cualitativa humana dio como resultado «Observada».");
  if (!complementary) parts.push("La revisión cualitativa automatizada no fue ejecutada.");
  else if (autoStats.total > 0) parts.push(`${automatedPrioritySentence(autoStats)}.`);
  else parts.push("Las consultas automatizadas ejecutadas no registraron hallazgos adicionales.");
  return parts.join(" ");
}

function sourceOverviewSentence(journal, detail) {
  const current = [];
  const absent = [];
  if (journal.scopus_status === "Active") current.push("Scopus");
  else if (!journal.scopus_status) absent.push("Scopus");
  if (journal.wos_status === "Current") current.push("Web of Science");
  else if (!wosNoLongerCurrent(journal, detail)) absent.push("Web of Science");
  if (journal.doaj_status === "Current" || journal.doaj_status === "Current (withdrawal history)") current.push("DOAJ");
  else if (journal.doaj_status !== "Withdrawn") absent.push("DOAJ");

  const clauses = [];
  if (current.length) clauses.push(`La revista está vigente en ${joinSpanish(current)}`);
  if (absent.length) clauses.push(`no figura indexada en ${joinNegativeSources(absent)}`);
  if (!clauses.length) return "";
  return `${clauses.join(" y ")}.`;
}

function joinNegativeSources(items) {
  if (!items.length) return "las fuentes consultadas";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ni en ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ni en ${items[items.length - 1]}`;
}

function summarySignalsHtml(complementary, autoStats, quantStatus, humanReview, journal = null, detail = null) {
  const items = [];
  const quantText = journal && detail ? publicQuantitativeLabel(journal, detail) : quantLabel(quantStatus);
  items.push(`<span><strong>Evaluación cuantitativa:</strong> ${escapeHtml(quantText)}</span>`);
  if (humanReview) {
    const humanLabel = humanReview.status === "Culminada" && humanReview.result
      ? humanReview.result
      : humanReview.status;
    items.push(`<span><strong>Revisión humana:</strong> ${escapeHtml(humanLabel)}</span>`);
  }
  if (!complementary) items.push("<span><strong>Revisión automatizada:</strong> No ejecutada</span>");
  else if (autoStats.total > 0) items.push(`<span><strong>Revisión automatizada:</strong> ${escapeHtml(automatedPrioritySentence(autoStats))}</span>`);
  else items.push("<span><strong>Revisión automatizada:</strong> Sin hallazgos en las consultas ejecutadas</span>");
  return `<div class="summary-signal-list integrated">${items.join("")}</div>`;
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
      "Indicadores disponibles en Web of Science / InCites. El JIF se muestra como métrica de revista; el CNCI y el JCI se presentan como indicadores complementarios.",
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
  return `<div class="metric ${escapeHtml(metric.tone || "normal")}">
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

function sourceCoverageEnd(journal, detail, source) {
  if (source === "scimago") {
    const coverage = extractCoverageYears(journal?.scopus_coverage);
    return coverage.end || null;
  }
  const series = sourceSeriesValues(detail?.incites, "wos_documents");
  if (journal?.wos_status === "Current") return null;
  return series.length ? Number(series.at(-1).year) : null;
}

function productionSeriesForSource(journal, detail, source) {
  const isScimago = source === "scimago";
  const raw = sourceSeriesValues(isScimago ? detail?.sjr : detail?.incites, isScimago ? "total_docs_year" : "wos_documents");
  const end = sourceCoverageEnd(journal, detail, source);
  if (!end) return raw;
  return raw.filter(item => Number(item.year) <= end);
}

function sourceCoverageEndedBeforeCurrentPeriod(journal, detail, source) {
  const end = sourceCoverageEnd(journal, detail, source);
  if (!end || end >= 2025) return false;
  if (source === "scimago") return journal?.scopus_status !== "Active" || end < 2025;
  return journal?.wos_status !== "Current";
}

function metricSeriesContext(journal, detail, source) {
  const series = productionSeriesForSource(journal, detail, source);
  const first = series[0];
  const latest = series.at(-1);
  return { series, first, latest, range: series.length ? `${first.year}–${latest.year}` : "", coverageEnd: sourceCoverageEnd(journal, detail, source) };
}

function sourceProductionMetric(journal, detail, source) {
  const isScimago = source === "scimago";
  const sourceName = isScimago ? "Scopus" : "Web of Science/InCites";
  const label = isScimago ? "Producción SCImago" : "Producción InCites";
  const current = isScimago ? journal.sjr_docs_2025 : journal.incites_docs_2025;
  const baseline = isScimago ? journal.sjr_docs_baseline_median : journal.incites_docs_baseline_median;
  const ratio = isScimago ? journal.sjr_production_ratio : journal.incites_production_ratio;
  const signal = isScimago ? journal.production_signal_scimago : journal.production_signal_incites;
  const context = metricSeriesContext(journal, detail, source);
  if (context.latest && sourceCoverageEndedBeforeCurrentPeriod(journal, detail, source)) {
    return { label, value: "No evaluable en el periodo actual", note: `La cobertura disponible en ${sourceName} termina en ${context.latest.year}. Los años posteriores no se consideran producción cero.`, tone: "historical" };
  }
  if (!hasMetricValue(ratio)) {
    if (context.series.length) {
      const reasons = [];
      const baseYears = context.series.filter(item => Number(item.year) >= 2020 && Number(item.year) <= 2024).length;
      if (baseYears < 3) reasons.push(`solo hay ${baseYears} años utilizables en la línea base 2020–2024; se requieren al menos 3`);
      if (hasMetricValue(current) && Number(current) < 50) reasons.push(`la fuente registra ${integerFormat(current)} documentos en 2025 y la comparación requiere al menos 50 en ese año`);
      if (hasMetricValue(baseline) && Number(baseline) < 20) reasons.push(`la mediana 2020–2024 es ${numberFormat(baseline)} y la comparación requiere al menos 20`);
      return { label, value: "Información insuficiente para evaluar", note: reasons.length ? capitalize(reasons.join("; ")) : `Existe una serie ${context.range}, pero no cumple todos los mínimos metodológicos.`, tone: "limited" };
    }
    return { label, value: "Dato no disponible", note: "No se dispone de una serie anual de producción utilizable en la fuente consultada.", tone: "missing" };
  }
  const change = (Number(ratio) - 1) * 100;
  const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(1)} %`;
  const baseText = `Mediana 2020–2024: ${numberFormat(baseline)}; diferencia: ${changeText}.`;
  const value = `${integerFormat(current)} documentos`;
  if (signal === "Extreme") return { label: `${label} 2025`, value, note: `Crecimiento extremo. ${baseText}`, tone: "high" };
  if (signal === "Moderate") return { label: `${label} 2025`, value, note: `Crecimiento moderado. ${baseText}`, tone: "moderate" };
  return { label: `${label} 2025`, value, note: `${baseText} Variación dentro del rango esperado.`, tone: "normal" };
}

function inferSingleYearProductionSignal(journal, detail) {
  const series = productionSeriesForSource(journal, detail, "scimago")
    .filter(item => Number(item.total_docs_year) > 0);
  let best = null;
  for (let index = 1; index < series.length; index += 1) {
    const previous = Number(series[index - 1].total_docs_year);
    const current = Number(series[index].total_docs_year);
    if (!previous || current < 50) continue;
    const ratio = current / previous;
    if (!best || ratio > best.ratio) best = {
      year: Number(series[index].year),
      previousYear: Number(series[index - 1].year),
      previousValue: previous,
      currentValue: current,
      ratio
    };
  }
  return best;
}

function scimagoPersistenceMetric(journal, detail) {
  const years = Number(journal.production_persistent_years || 0);
  const status = journal.production_persistence_status || "";
  const context = metricSeriesContext(journal, detail, "scimago");
  const ended = context.latest && sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "scimago");
  const productionComparable = hasMetricValue(journal.sjr_production_ratio);
  const initialSignal = journal.production_signal_scimago || journal.production_signal || "";
  if (!status || status === "No comparable signal") {
    if (ended) return { label: "Persistencia de la producción", value: "No evaluable en el periodo actual", note: `La cobertura termina en ${context.latest.year}; no puede comprobarse persistencia reciente.`, tone: "historical" };
    if (productionComparable && (!initialSignal || initialSignal === "None" || initialSignal === "No production signal")) {
      return { label: "Persistencia de la producción", value: "Sin señal persistente", note: "No se detectó un crecimiento atípico inicial que requiera comprobar su repetición en varios años.", tone: "normal" };
    }
    if (context.series.length) {
      const baseYears = context.series.filter(item => Number(item.year) >= 2020 && Number(item.year) <= 2024).length;
      const reasons = [];
      if (baseYears < 3) reasons.push(`solo hay ${baseYears} años utilizables en la línea base 2020–2024; se requieren al menos 3`);
      if (!productionComparable) reasons.push("no se dispone de una comparación válida para el año evaluado");
      return { label: "Persistencia de la producción", value: "Información insuficiente para evaluar", note: capitalize(reasons.join("; ") || "La serie no reúne las ventanas comparables requeridas por la metodología."), tone: "limited" };
    }
    return { label: "Persistencia de la producción", value: "Dato no disponible", note: "No se dispone de una serie anual SCImago vinculada a esta revista.", tone: "missing" };
  }
  if (years >= 2 || status === "Persistent growth") return { label: "Persistencia de la producción", value: `${years || 2} años`, note: "El crecimiento atípico se repitió en más de un año de la ventana evaluada.", tone: years >= 3 ? "high" : "moderate" };
  if (years === 1 || status === "Single-year signal") {
    const candidate = inferSingleYearProductionSignal(journal, detail);
    const label = ended ? "Señal histórica de producción" : "Persistencia de la producción";
    const value = candidate ? String(candidate.year) : "1 año";
    const note = candidate
      ? `La producción pasó de ${integerFormat(candidate.previousValue)} documentos en ${candidate.previousYear} a ${integerFormat(candidate.currentValue)} en ${candidate.year}. El aumento no se repitió en otro año y, por ello, no se considera persistente.`
      : "La señal apareció en un solo año de la ventana evaluada y no se considera persistente.";
    return { label, value, note, tone: ended ? "historical" : "normal" };
  }
  return { label: "Persistencia de la producción", value: "Sin señal persistente", note: "No se detectó crecimiento atípico repetido.", tone: "normal" };
}

function bestQuartile(series) {
  const quartiles = (series || []).map(item => String(item.quartile || "").toUpperCase()).filter(value => /^Q[1-4]$/.test(value));
  if (!quartiles.length) return "No reportado";
  return quartiles.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))[0];
}

function scimagoSjrMetric(journal, detail) {
  const series = sourceSeriesValues(detail?.sjr, "sjr");
  const coverageEnd = sourceCoverageEnd(journal, detail, "scimago");
  const inCoverage = coverageEnd ? series.filter(item => Number(item.year) <= coverageEnd) : series;
  const latest = (inCoverage.length ? inCoverage : series).at(-1);
  const value = latest ? latest.sjr : (hasMetricValue(journal.sjr_2025) ? journal.sjr_2025 : journal.sjr);
  const year = latest?.year || journal.sjr_year || "";
  if (!hasMetricValue(value)) return { label: "SJR", value: "Dato no disponible", note: "No se dispone de un valor SJR para esta revista en los datos de SCImago consultados.", tone: "missing" };
  const usable = inCoverage.length ? inCoverage : series;
  const peak = usable.length ? usable.reduce((best, item) => Number(item.sjr) > Number(best.sjr) ? item : best, usable[0]) : null;
  const quartile = bestQuartile(usable) !== "No reportado" ? bestQuartile(usable) : (journal.sjr_quartile || "No reportado");
  const peakText = peak ? ` · mejor valor: ${numberFormat(peak.sjr)} (${peak.year})` : "";
  const postCoverage = coverageEnd && series.some(item => Number(item.year) > coverageEnd);
  return { label: coverageEnd && coverageEnd < 2025 ? `Último SJR durante la cobertura (${year})` : `SJR ${year}`.trim(), value: numberFormat(value), note: `Mejor cuartil alcanzado: ${quartile}${peakText}${postCoverage ? ". SCImago registra valores posteriores, pero no implican cobertura vigente." : ""}`, tone: "normal" };
}

function scimagoTrajectoryMetric(journal, detail) {
  const coverageEnd = sourceCoverageEnd(journal, detail, "scimago");
  const allSeries = sourceSeriesValues(detail?.sjr, "sjr");
  const series = coverageEnd ? allSeries.filter(item => Number(item.year) <= coverageEnd) : allSeries;
  const ended = sourceCoverageEndedBeforeCurrentPeriod(journal, detail, "scimago");
  const ratio = journal.sjr_change_ratio;
  const absolute = journal.sjr_absolute_change;
  const baseline = journal.sjr_baseline_median;
  const signal = journal.sjr_trajectory_signal;
  if (!ended && hasMetricValue(ratio)) {
    const change = (Number(ratio) - 1) * 100;
    const value = `${change >= 0 ? "+" : ""}${change.toFixed(1)} %`;
    const baselineText = hasMetricValue(baseline) ? ` frente a la mediana 2020–2024 (${numberFormat(baseline)})` : " frente al periodo 2020–2024";
    const absText = hasMetricValue(absolute) ? `; cambio absoluto: ${Number(absolute) >= 0 ? "+" : ""}${numberFormat(absolute)}` : "";
    if (signal === "Extreme") return { label: "Variación del SJR 2025", value, note: `Variación extrema${baselineText}${absText}.`, tone: "high" };
    if (signal === "Moderate") return { label: "Variación del SJR 2025", value, note: `Variación moderada${baselineText}${absText}.`, tone: "moderate" };
    return { label: "Variación del SJR 2025", value, note: `${value}${baselineText}${absText}. Variación dentro del rango esperado.`, tone: "normal" };
  }
  if (series.length >= 2) {
    const first = series[0];
    const latest = series.at(-1);
    const change = Number(first.sjr) !== 0 ? ((Number(latest.sjr) - Number(first.sjr)) / Number(first.sjr)) * 100 : null;
    const changeText = change == null ? "" : `${change >= 0 ? "+" : ""}${change.toFixed(1)} %`;
    return { label: "Trayectoria SJR", value: `${first.year}–${latest.year}`, note: `Durante la cobertura pasó de ${numberFormat(first.sjr)} a ${numberFormat(latest.sjr)}${changeText ? ` (${changeText})` : ""}. La gráfica muestra cada año.`, tone: ended ? "historical" : "normal" };
  }
  return { label: "Trayectoria SJR", value: "Información insuficiente para evaluar", note: "Se requiere más de un año con SJR para describir su evolución.", tone: "limited" };
}

function selfCitationMetric(journal) {
  if (!hasMetricValue(journal.source_self_cite_share)) return { label: "Autocitación de la revista", value: "Dato no disponible", note: "No se dispone de la información necesaria para calcular qué proporción de las citas procede de la propia revista.", tone: "missing" };
  if (journal.source_self_signal === "Extreme") return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `De cada 100 citas recibidas, aproximadamente ${Math.round(Number(journal.source_self_cite_share) * 100)} proceden de artículos publicados en la misma revista. Es una proporción muy alta y requiere revisión cualitativa.`, tone: "high" };
  if (journal.source_self_signal === "Moderate") return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `De cada 100 citas recibidas, aproximadamente ${Math.round(Number(journal.source_self_cite_share) * 100)} proceden de artículos publicados en la misma revista. Es una proporción elevada y conviene revisarla.`, tone: "moderate" };
  return { label: "Autocitación de la revista", value: percentage(journal.source_self_cite_share), note: `De cada 100 citas recibidas, aproximadamente ${Math.round(Number(journal.source_self_cite_share) * 100)} proceden de artículos publicados en la misma revista. No se detectó una proporción atípica.`, tone: "normal" };
}

function cnciMetric(journal) {
  if (!hasMetricValue(journal.cnci_2024)) return { label: "CNCI documental (complementario)", value: "Dato no disponible", note: "El CNCI no está disponible para el periodo consultado de esta revista.", tone: "missing" };
  if (journal.cnci_signal === "Extreme") return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Variación extrema del impacto normalizado de los documentos; requiere revisión.", tone: "high" };
  if (journal.cnci_signal === "Moderate") return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Variación elevada del impacto normalizado de los documentos; requiere revisión.", tone: "moderate" };
  return { label: "CNCI documental (complementario)", value: numberFormat(journal.cnci_2024), note: "Impacto normalizado de los documentos, sin anomalía detectada. No sustituye al JIF.", tone: "normal" };
}

function jifMetric(journal) {
  if (!hasMetricValue(journal.jif_current)) return { label: "JIF", value: "Dato no disponible", note: "El JIF no está disponible en los datos de InCites consultados para esta revista.", tone: "missing" };
  return { label: "JIF disponible en InCites", value: numberFormat(journal.jif_current), note: `Cuartil JIF: ${journal.jif_quartile || "No reportado"}. Se muestra como valor de referencia de la revista; no se interpreta como una serie histórica del JIF.`, tone: "normal" };
}

function jifDependencyMetric(journal) {
  if (!hasMetricValue(journal.jif_current)) return { label: "JIF sin autocitas", value: "Dato no disponible", note: "Sin un JIF disponible no puede evaluarse su diferencia respecto del valor sin autocitas.", tone: "missing" };
  if (!hasMetricValue(journal.jif_without_self) || !hasMetricValue(journal.jif_self_dependency)) {
    return { label: "JIF sin autocitas", value: "Información insuficiente para evaluar", note: "Existe un JIF disponible, pero falta el valor sin autocitas o alguno de los datos necesarios para medir la dependencia.", tone: "limited" };
  }
  const dependency = percentage(journal.jif_self_dependency);
  const explanation = `Al retirar las autocitas, el JIF baja de ${numberFormat(journal.jif_current)} a ${numberFormat(journal.jif_without_self)}. La diferencia equivale al ${dependency} del JIF original.`;
  if (journal.jif_self_signal === "Extreme") return { label: "Dependencia del JIF respecto de autocitas", value: dependency, note: `${explanation} Es una dependencia muy alta y requiere revisión cualitativa.`, tone: "high" };
  if (journal.jif_self_signal === "Moderate") return { label: "Dependencia del JIF respecto de autocitas", value: dependency, note: `${explanation} Es una dependencia elevada y conviene revisarla junto con otras evidencias.`, tone: "moderate" };
  return { label: "Dependencia del JIF respecto de autocitas", value: dependency, note: `${explanation} No se detectó una dependencia atípica.`, tone: "normal" };
}

function jciMetric(journal) {
  if (!hasMetricValue(journal.jci)) return { label: "JCI", value: "Dato no disponible", note: "El JCI no está disponible para esta revista en los datos de InCites consultados.", tone: "missing" };
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

function combinedTimelineEvents(journal, detail, complementary) {
  const combined = [...(Array.isArray(detail?.events) ? detail.events : [])];

  const scopusCoverage = extractCoverageYears(journal?.scopus_coverage);
  const scopusSegments = scopusCoverage.segments || [];
  const scopusEventAt = (year, types = []) => combined.some(event => {
    const source = String(event.source || "").toLowerCase();
    const type = String(event.event_type_normalized || event.event_type || "").toLowerCase();
    return source.includes("scopus") && Number(event.event_year || String(event.event_date || "").slice(0, 4)) === Number(year) && (!types.length || types.includes(type));
  });

  scopusSegments.forEach((segment, index) => {
    const earlier = scopusSegments.slice(0, index).some(item => item.end < segment.start);
    if (segment.start === segment.end) {
      if (!scopusEventAt(segment.start)) {
        combined.push({ source: "Scopus", event_type: "Coverage record", event_year: segment.start, title: `Año de cobertura registrado: ${segment.start}`, reason: "El año aparece como un periodo independiente en los datos de cobertura disponibles.", synthetic_coverage: true });
      }
      return;
    }
    const type = earlier ? "Coverage restart" : "Coverage start";
    const acceptedTypes = ["added", "accepted", "coverage start", "coverage restart"];
    if (!scopusEventAt(segment.start, acceptedTypes)) {
      combined.push({ source: "Scopus", event_type: type, event_year: segment.start, title: `Cobertura registrada: ${segment.start}–${segment.end}`, reason: earlier ? "El rango aparece separado de un periodo de cobertura anterior en los datos disponibles." : "El año se obtiene del rango de cobertura disponible.", synthetic_coverage: true });
    }
  });

  const hasScopusEnd = combined.some(event => {
    const source = String(event.source || "").toLowerCase();
    const type = String(event.event_type_normalized || event.event_type || "").toLowerCase();
    return source.includes("scopus") && ["discontinuation", "coverage end", "cease"].includes(type);
  });
  if (scopusCoverage.end && journal?.scopus_status !== "Active" && !hasScopusEnd) {
    combined.push({ source: "Scopus", event_type: "Coverage end", event_year: scopusCoverage.end, title: `Último año de cobertura registrada: ${scopusCoverage.end}`, reason: "La revista figura actualmente como inactiva en Scopus.", synthetic_coverage: true });
  }

  const incitesSeries = sourceSeriesValues(detail?.incites, "wos_documents");
  const incitesStart = incitesSeries[0]?.year || extractCoverageYears(journal?.wos_historical_range).start;
  const incitesEnd = incitesSeries.at(-1)?.year || extractCoverageYears(journal?.wos_historical_range).end;
  const hasWosSeriesStart = combined.some(event => {
    const source = String(event.source || "").toLowerCase();
    const type = String(event.event_type_normalized || event.event_type || "").toLowerCase();
    return (source === "wos" || source.includes("web of science") || source.includes("incites")) && ["added", "accepted", "data series start"].includes(type);
  });
  const hasWosEvidence = journal?.wos_status === "Current" || hasHistoricalWosData(detail);
  if (hasWosEvidence && incitesStart && !hasWosSeriesStart) {
    combined.push({ source: "WoS", event_type: "Data series start", event_year: incitesStart, title: `Serie histórica de InCites disponible desde ${incitesStart}`, reason: "Esta fecha indica el inicio de los datos disponibles y no necesariamente el año oficial de indexación en Web of Science.", synthetic_coverage: true });
  }
  const hasWosSeriesEnd = combined.some(event => {
    const source = String(event.source || "").toLowerCase();
    const type = String(event.event_type_normalized || event.event_type || "").toLowerCase();
    return (source === "wos" || source.includes("web of science") || source.includes("incites")) && type === "data series end";
  });
  if (hasWosEvidence && incitesEnd && journal?.wos_status !== "Current" && !hasWosSeriesEnd) {
    combined.push({ source: "WoS", event_type: "Data series end", event_year: incitesEnd, title: `Último año con información histórica disponible en InCites: ${incitesEnd}`, reason: "Esta fecha no necesariamente corresponde al año oficial de desindexación en Web of Science.", synthetic_coverage: true });
  }

  const seen = new Set();
  (complementary?.crossref?.events || []).filter(item => item.severity === "high_signal").forEach(event => {
    const key = normalizeDoi(event.notice_doi || event.work_doi) || `${event.event_type}|${event.notice_title}|${event.notice_date}`;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push({ source: event.metadata_source === "retraction-watch" ? "Retraction Watch / Crossref" : "Crossref", event_type: event.event_type, event_date: event.notice_date || "", title: event.notice_title || editorialEventLabel(event.event_type), reason: event.work_doi ? `Registro asociado: ${event.work_doi}` : "", automated_evidence: true });
  });
  (complementary?.openalex?.retracted_works || []).forEach(item => {
    const key = normalizeDoi(item.doi) || `openalex|${item.title}|${item.year}`;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push({ source: "OpenAlex", event_type: "retraction", event_year: item.year || "", title: item.title || "Obra marcada como retractada", reason: item.doi ? `DOI: ${normalizeDoi(item.doi)}` : "", automated_evidence: true });
  });
  return combined;
}

function parseCoverageSegments(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const segments = [];
  raw.split(/[;,]+/).map(part => part.trim()).filter(Boolean).forEach(part => {
    const years = part.match(/(?:19|20)\d{2}/g) || [];
    if (!years.length) return;
    const start = Number(years[0]);
    const end = Number(years[1] || years[0]);
    segments.push({ start: Math.min(start, end), end: Math.max(start, end), standalone: years.length === 1 });
  });
  return segments.sort((a, b) => a.start - b.start || a.end - b.end);
}

function formatCoverageDisplay(value) {
  const segments = parseCoverageSegments(value);
  if (!segments.length) return String(value || "");
  return segments.map(segment => segment.start === segment.end ? String(segment.start) : `${segment.start}–${segment.end}`).join("; ");
}

function extractCoverageYears(value) {
  const segments = parseCoverageSegments(value);
  if (!segments.length) return { start: null, end: null, segments: [] };
  return {
    start: Math.min(...segments.map(item => item.start)),
    end: Math.max(...segments.map(item => item.end)),
    segments
  };
}

function coverageSeriesStartNote(journal, detail) {
  const coverage = extractCoverageYears(journal?.scopus_coverage);
  if (!coverage.start) return "";

  const production = sourceSeriesValues(detail?.sjr, "total_docs_year");
  const sjr = sourceSeriesValues(detail?.sjr, "sjr");
  const availableStarts = [];

  if (production.length && Number(production[0].year) > Number(coverage.start)) {
    availableStarts.push(`la producción disponible comienza en ${production[0].year}`);
  }
  if (sjr.length && Number(sjr[0].year) > Number(coverage.start)) {
    availableStarts.push(`el SJR disponible comienza en ${sjr[0].year}`);
  }
  if (!availableStarts.length) return "";

  return `<p class="timeline-data-note">El inicio de la cobertura y el inicio de las series bibliométricas disponibles pueden no coincidir. En esta ficha, ${escapeHtml(joinSpanish(availableStarts))}.</p>`;
}

function timelineHtml(events) {
  const ordered = [...events].sort((a, b) => eventValue(a) - eventValue(b));
  return `<div class="timeline">${ordered.map(event => {
    const source = event.source === "WoS" ? "Web of Science" : event.source;
    const rawSource = String(event.source || "").toLowerCase();
    const sourceClass = event.automated_evidence ? "evidence" : (event.source === "WoS" ? "wos" : rawSource);
    const eventType = event.event_type_normalized || event.event_type;
    const adverse = ["Discontinuation", "Editorial De-listing", "Production De-listing", "Withdrawn", "Coverage end", "Data series end", "retraction", "expression_of_concern", "withdrawal", "removal"].includes(eventType);
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
    "Coverage start": "Inicio de cobertura",
    "Coverage restart": "Reinicio de cobertura",
    "Coverage record": "Cobertura registrada",
    "Coverage end": "Fin de cobertura registrada",
    "Data series start": "Inicio de serie histórica",
    "Data series end": "Fin de serie histórica disponible",
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
  const rawValid = sourceSeriesValues(series, key);
  const yearly = new Map();
  rawValid.forEach(item => yearly.set(Number(item.year), item));
  const valid = Array.from(yearly.values()).sort((a, b) => Number(a.year) - Number(b.year));
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
  const coverageEnd = Number(options.coverageEnd || 0);
  const currentYear = Number(options.currentYear || 0);
  const prePoints = coverageEnd ? points.filter(point => Number(point.year) <= coverageEnd) : (currentYear ? points.filter(point => Number(point.year) < currentYear) : points);
  const postPointsOnly = coverageEnd ? points.filter(point => Number(point.year) > coverageEnd) : [];
  const currentPointsOnly = !coverageEnd && currentYear ? points.filter(point => Number(point.year) >= currentYear) : [];
  const postPoints = postPointsOnly.length && prePoints.length ? [prePoints.at(-1), ...postPointsOnly] : postPointsOnly;
  const currentPoints = currentPointsOnly.length && prePoints.length ? [prePoints.at(-1), ...currentPointsOnly] : currentPointsOnly;
  const linePoints = pts => pts.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const mainPolyline = prePoints.length > 1 ? `<polyline class="series-line" points="${linePoints(prePoints)}"></polyline>` : "";
  const postPolyline = postPoints.length > 1 ? `<polyline class="series-line post-coverage-line" points="${linePoints(postPoints)}"></polyline>` : "";
  const currentPolyline = currentPoints.length > 1 ? `<polyline class="series-line current-year-line" points="${linePoints(currentPoints)}"></polyline>` : "";
  let specialZone = "";
  const zonePoints = postPointsOnly.length ? postPointsOnly : currentPointsOnly;
  if (zonePoints.length) {
    const firstSpecial = zonePoints[0];
    const lastPre = prePoints.at(-1);
    const startX = lastPre ? (lastPre.x + firstSpecial.x) / 2 : firstSpecial.x - xStep / 2;
    const zoneWidth = width - padding.right - startX;
    const zoneMid = startX + zoneWidth / 2;
    const zoneClass = postPointsOnly.length ? "post-coverage-zone" : "current-year-zone";
    const labelClass = postPointsOnly.length ? "post-coverage-label" : "current-year-label";
    const lines = postPointsOnly.length ? ["Periodo posterior", "a la cobertura"] : [`${currentYear}`, "año en curso"];
    specialZone = `<rect class="${zoneClass}" x="${startX.toFixed(1)}" y="${padding.top}" width="${zoneWidth.toFixed(1)}" height="${chartHeight}"></rect><text class="${labelClass}" x="${zoneMid.toFixed(1)}" y="${padding.top + 16}" text-anchor="middle"><tspan x="${zoneMid.toFixed(1)}" dy="0">${lines[0]}</tspan><tspan x="${zoneMid.toFixed(1)}" dy="13">${lines[1]}</tspan></text>`;
  }
  const pointClass = point => coverageEnd && Number(point.year) > coverageEnd ? "post-coverage-point" : currentYear && Number(point.year) >= currentYear ? "current-year-point" : "";
  const pointSuffix = point => coverageEnd && Number(point.year) > coverageEnd ? " · posterior al fin de cobertura" : currentYear && Number(point.year) >= currentYear ? " · año en curso" : "";
  const dots = points.map(point => `<circle tabindex="0" class="${pointClass(point)}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6" aria-label="${escapeHtml(String(point.year))}: ${escapeHtml(formatValue(point.value))} ${escapeHtml(measureLabel)}${pointSuffix(point)}"><title>${point.year}: ${formatValue(point.value)} ${measureLabel}${point.annotation ? ` · ${point.annotation}` : ""}${pointSuffix(point)}</title></circle>`).join("");
  const showPointValues = options.showPointValues !== false && points.length <= 14;
  const pointValues = showPointValues ? points.map((point, index) => {
    const shift = index % 2 === 0 ? -14 : 22;
    const y = Math.max(18, point.y + shift);
    const specialClass = coverageEnd && Number(point.year) > coverageEnd ? "post-coverage-value" : currentYear && Number(point.year) >= currentYear ? "current-year-value" : "";
    return `<text class="point-value ${specialClass}" x="${point.x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${escapeHtml(formatValue(point.value))}${point.annotation ? ` · ${escapeHtml(String(point.annotation))}` : ""}</text>`;
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
  const latest = options.headlineItem || valid[valid.length - 1];
  const headlineCurrent = currentYear && Number(latest.year) >= currentYear ? " · año en curso" : "";
  const annotationHead = options.annotationKey ? `<th>${escapeHtml(options.annotationLabel || "Categoría")}</th>` : "";
  const annotationCells = item => options.annotationKey ? `<td>${escapeHtml(item[options.annotationKey] || "No reportado")}</td>` : "";

  return `<div class="chart-card ${sourceClass}">
    <div class="chart-card-heading"><h3>${escapeHtml(title)}</h3><span>${escapeHtml(String(latest.year))}: <strong>${escapeHtml(formatValue(latest[key]))}</strong>${options.annotationKey && latest[options.annotationKey] ? ` · ${escapeHtml(String(latest[options.annotationKey]))}` : ""}${headlineCurrent}</span></div>
    ${options.contextNote ? `<p class="chart-context-note">${escapeHtml(options.contextNote)}</p>` : ""}
    <div class="chart-wrap"><svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}: ${escapeHtml(measureLabel)} por año">
      ${gridLines}${specialZone}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <text class="axis-value" x="42" y="${height - padding.bottom + 4}">0</text>
      ${mainPolyline}${postPolyline}${currentPolyline}${dots}${pointValues}${labels}
    </svg></div>
    <p class="chart-help">Los valores se muestran sobre los puntos; pase el cursor para consultar el detalle.</p>
    <details class="chart-data"><summary>Ver datos anuales</summary><div class="chart-table-wrap"><table><thead><tr><th>Año</th><th>${escapeHtml(capitalize(measureLabel))}</th>${annotationHead}</tr></thead><tbody>${valid.map(item => `<tr><td>${escapeHtml(String(item.year))}${currentYear && Number(item.year) >= currentYear ? " (en curso)" : ""}</td><td>${escapeHtml(formatValue(item[key]))}</td>${annotationCells(item)}</tr>`).join("")}</tbody></table></div></details>
  </div>`;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function effectiveHumanReview(journal, record) {
  if (record) return record;

  const legacyStatus = journal.qualitative_review_status;
  const legacyResult = journal.qualitative_review_result;
  if (legacyStatus === "Completed") {
    if (legacyResult === "Observed") {
      return { status: "Culminada", result: "Observada", review_date: journal.review_date || "", public_summary: journal.qualitative_summary || "", evidence: [], legacy: true };
    }
    if (legacyResult === "No additional alert") {
      return { status: "Culminada", result: "Sin hallazgos", review_date: journal.review_date || "", public_summary: journal.qualitative_summary || "", evidence: [], legacy: true };
    }
    if (legacyResult === "Monitor") {
      return { status: "En proceso", result: "", review_date: journal.review_date || "", public_summary: journal.qualitative_summary || "", evidence: [], legacy: true };
    }
  }
  return null;
}

function normalizedHumanReviewStatus(review) {
  const raw = String(review?.status || "").trim();
  const value = raw.toLowerCase();
  if (!value || value.includes("no inici")) return "No iniciado";
  if (value.includes("no requiere")) return "No requiere por ahora";
  if (value.includes("en proceso")) return "En proceso";
  if (value.includes("culmin")) return "Culminada";
  return raw || "No iniciado";
}

function normalizedHumanReviewResult(review) {
  const raw = String(review?.result || "").trim();
  const value = raw.toLowerCase();
  if (value.includes("observ")) return "Observada";
  if (value.includes("sin hallaz")) return "Sin hallazgos";
  return raw;
}

function applyLocalHumanReviewDemo(review) {
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!isLocal) return review;

  const mode = new URLSearchParams(location.search).get("human_demo");
  if (!mode) return review;

  const date = review?.review_date || "2026-07-21";
  const base = { evidence: [], public_summary: "", local_demo: true };
  if (mode === "no_findings") return { ...base, status: "Culminada", result: "Sin hallazgos", review_date: date };
  if (mode === "not_required") return { ...base, status: "No requiere por ahora", result: "", review_date: "" };
  if (mode === "in_process") return { ...base, status: "En proceso", result: "", review_date: date };
  if (mode === "not_started") return { ...base, status: "No iniciado", result: "", review_date: "" };
  return review;
}

function humanReviewSectionBadge(review) {
  const status = normalizedHumanReviewStatus(review);
  const result = normalizedHumanReviewResult(review);
  if (status === "Culminada" && result === "Observada") return '<span class="section-result-badge observed">Observada</span>';
  if (status === "Culminada" && result === "Sin hallazgos") return '<span class="section-result-badge positive">Sin hallazgos</span>';
  if (status === "En proceso") return '<span class="section-result-badge pending">En proceso</span>';
  if (status === "No requiere por ahora") return '<span class="section-result-badge neutral">No requiere por ahora</span>';
  return '<span class="section-result-badge neutral">No iniciado</span>';
}

function humanReviewOverviewHtml(items, tone) {
  const safeItems = items.filter(item => item && item.value);
  const columns = Math.max(1, Math.min(3, safeItems.length));
  return `
    <div class="human-review-overview ${escapeHtml(tone)} cols-${columns}">
      ${safeItems.map(item => `
        <div class="human-review-meta-item">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>`).join("")}
    </div>`;
}

function qualitativeHtml(review) {
  const status = normalizedHumanReviewStatus(review);
  const result = normalizedHumanReviewResult(review);
  const reviewDate = review?.review_date ? formatPublicDate(review.review_date) : "";

  if (status === "Culminada") {
    const observed = result === "Observada";
    const noFindings = result === "Sin hallazgos";
    const tone = observed ? "observed" : noFindings ? "no-findings" : "neutral";
    const overview = humanReviewOverviewHtml([
      { label: "Estado", value: status },
      { label: "Resultado", value: result || "Sin resultado" },
      { label: "Fecha de revisión", value: reviewDate }
    ], tone);

    if (!observed) return overview;

    const evidence = Array.isArray(review?.evidence)
      ? review.evidence.filter(item => item.visibility === "Pública")
      : [];

    return `${overview}
      ${evidence.length ? `<div class="human-evidence-list">${evidence.map(humanEvidenceCardHtml).join("")}</div>` : ""}
      ${review?.public_summary ? `
        <div class="human-review-conclusion observed">
          <h3>Conclusión de la revisión humana</h3>
          <p>${escapeHtml(review.public_summary)}</p>
        </div>` : ""}`;
  }

  if (status === "En proceso") {
    return humanReviewOverviewHtml([
      { label: "Estado", value: status },
      { label: "Fecha de actualización", value: reviewDate }
    ], "in-progress");
  }

  if (status === "No requiere por ahora") {
    return humanReviewOverviewHtml([
      { label: "Estado", value: status }
    ], "neutral");
  }

  return humanReviewOverviewHtml([
    { label: "Estado", value: "No iniciado" }
  ], "neutral");
}

function humanEvidenceCardHtml(item) {
  const sourceLink = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.source || "Consultar fuente")}</a>`
    : escapeHtml(item.source || "Fuente no indicada");
  const consulted = item.consulted_date ? formatPublicDate(item.consulted_date) : "";
  return `
    <article class="human-evidence-card">
      <header>
        <div><p class="human-evidence-kicker">${escapeHtml(item.category || "Hallazgo documentado")}</p></div>
        ${item.assessment ? `<span class="human-evidence-assessment">${escapeHtml(item.assessment)}</span>` : ""}
      </header>
      <div class="human-evidence-text">${humanEvidenceFindingHtml(item.finding || "")}</div>
      <footer>
        <span class="human-evidence-source"><strong>Fuente:</strong><span class="human-evidence-source-value">${sourceLink}</span></span>
        ${consulted ? `<span class="human-evidence-date"><strong>Fecha de consulta:</strong> ${escapeHtml(consulted)}</span>` : ""}
      </footer>
    </article>`;
}

function humanEvidenceFindingHtml(value) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const blocks = normalized.split(/\n\s*\n/);
  if (blocks.length < 2) return multilineHtml(normalized);

  const subtitle = blocks.shift().trim().replace(/[:：]\s*$/, "");
  const body = blocks.join("\n\n").trim();
  return `
    <p class="human-evidence-subtitle"><strong>${escapeHtml(subtitle)}:</strong></p>
    ${body ? `<div class="human-evidence-body">${multilineHtml(body)}</div>` : ""}`;
}

function multilineHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function formatPublicDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function openAlexSectionHtml(openalex, journal, detail) {
  if (!openalex || !openalex.source) return "";
  const source = openalex.source;
  const production = openalex.production_by_year || [];
  const assessment = openAlexCoverageAssessment(openalex, journal, detail);
  const hIndex = source.summary_stats?.h_index;
  const oaShare = openalex.oa_share == null ? "Sin dato" : `${openalex.oa_share} %`;
  const extraFlags = assessment.incomplete
    ? [{ code: "incomplete_recent_coverage", message: assessment.explanation }]
    : [];
  const quality = openAlexQualityHtml([...(openalex.quality_flags || []), ...extraFlags]);
  const openAlexUrl = source.id || "";
  const recentProduction = sourceSeriesValues(production, "works_count")
    .filter(item => Number(item.year) >= 2020);
  const chartSeries = recentProduction.length >= 3 ? recentProduction : production;
  const chartPeriod = sourceSeriesRange(chartSeries, "works_count");
  const productionChartTitle = chartPeriod
    ? `Producción registrada en OpenAlex (${chartPeriod})`
    : "Producción registrada en OpenAlex";
  const citationsChartTitle = chartPeriod
    ? `Citas acumuladas de documentos publicados por año en OpenAlex (${chartPeriod})`
    : "Citas acumuladas de documentos publicados por año en OpenAlex";
  const citationsContextNote = "Los documentos publicados en los años más recientes han tenido menos tiempo para acumular citas. Estos valores no deben interpretarse por sí solos como una disminución del impacto de la revista.";
  const narrative = assessment.incomplete ? "" : openAlexNarrative(chartSeries, openalex.oa_share);
  const metricNote = assessment.incomplete
    ? "Total del registro enlazado en OpenAlex; no representa de forma suficiente la producción reciente."
    : "Total atribuido por OpenAlex";
  const citationNote = assessment.incomplete
    ? "Conteo acumulado del registro enlazado; debe leerse como referencia histórica."
    : "Conteo acumulado en OpenAlex";
  const indexNote = assessment.incomplete
    ? "Indicador del registro enlazado; no se usa para evaluar la situación reciente."
    : "Indicador calculado por OpenAlex";
  const oaNote = assessment.incomplete
    ? "Proporción calculada sobre la serie incompleta recuperada."
    : "Participación en la serie utilizada";

  const charts = assessment.incomplete
    ? `<details class="openalex-history-details"><summary>Ver serie histórica incompleta recuperada de OpenAlex</summary><p>Estos datos se conservan para trazabilidad, pero no se utilizan para evaluar la tendencia actual de la revista.</p><div class="charts-grid openalex-charts">${chartBlock("Producción histórica registrada en OpenAlex", production, "works_count", "openalex", "documentos", { currentYear: new Date().getFullYear() })}${chartBlock("Citas acumuladas de documentos publicados por año en OpenAlex", production, "cited_by_count", "openalex-citations", "citas", { currentYear: new Date().getFullYear(), contextNote: citationsContextNote })}</div></details>`
    : `<div class="charts-grid openalex-charts">${chartBlock(productionChartTitle, chartSeries, "works_count", "openalex", "documentos", { currentYear: new Date().getFullYear() })}${chartBlock(citationsChartTitle, chartSeries, "cited_by_count", "openalex-citations", "citas", { currentYear: new Date().getFullYear(), contextNote: citationsContextNote })}</div>${sourceSeriesValues(production, "works_count").some(item => Number(item.year) < 2020) ? `<details class="openalex-history-details"><summary>Ver trayectoria histórica completa</summary><div class="charts-grid openalex-charts">${chartBlock("Producción histórica registrada en OpenAlex", production, "works_count", "openalex", "documentos", { currentYear: new Date().getFullYear() })}${chartBlock("Citas acumuladas de documentos publicados por año en OpenAlex", production, "cited_by_count", "openalex-citations", "citas", { currentYear: new Date().getFullYear(), contextNote: citationsContextNote })}</div></details>` : ""}`;

  return `
    <section class="journal-section openalex-section">
      <div class="section-heading">
        <div><p class="section-kicker">Fuente bibliométrica abierta</p><h2>Análisis complementario con OpenAlex</h2></div>
      </div>
      <p class="openalex-intro">OpenAlex aporta una lectura adicional sobre producción, citación, acceso abierto y procedencia institucional. No sustituye el estado oficial de Scopus, Web of Science o DOAJ.</p>
      ${assessment.incomplete ? openAlexCoverageWarningHtml(assessment) : ""}
      ${openAlexComplementaryEvaluationHtml(openalex, assessment)}
      <div class="openalex-metrics">
        ${openAlexMetric("Documentos registrados", integerFormat(source.works_count), metricNote)}
        ${openAlexMetric("Citas registradas", integerFormat(source.cited_by_count), citationNote)}
        ${openAlexMetric("Índice h", hIndex == null ? "Sin dato" : integerFormat(hIndex), indexNote)}
        ${openAlexMetric("Producción en acceso abierto", oaShare, oaNote)}
      </div>
      ${narrative}
      ${charts}
      ${quality}
      ${openAlexExplorerHtml(openalex.top || {})}
      <div class="openalex-source-note">
        <span><strong>Fuente:</strong> ${escapeHtml(source.display_name || "OpenAlex")}${source.host_organization_name ? ` · ${escapeHtml(source.host_organization_name)}` : ""}</span>
        ${source.updated_date ? `<span><strong>Actualización del registro:</strong> ${escapeHtml(formatDate(source.updated_date))}</span>` : ""}
        ${openAlexUrl ? `<a href="${escapeHtml(openAlexUrl)}" target="_blank" rel="noopener">Ver registro en OpenAlex</a>` : ""}
      </div>
    </section>`;
}

function latestCompleteSourceValue(series, key, lastCompleteYear) {
  const values = sourceSeriesValues(series, key).filter(item => Number(item.year) <= lastCompleteYear);
  return values.length ? values.at(-1) : null;
}

function openAlexCoverageAssessment(openalex, journal, detail) {
  const currentYear = new Date().getFullYear();
  const lastCompleteYear = currentYear - 1;
  const series = sourceSeriesValues(openalex?.production_by_year, "works_count")
    .filter(item => Number(item.year) <= lastCompleteYear);
  const positive = series.filter(item => Number(item.works_count) > 0);
  const lastPositive = positive.length ? positive.at(-1) : null;
  const activeElsewhere = journal?.scopus_status === "Active"
    || journal?.wos_status === "Current"
    || String(journal?.doaj_status || "").startsWith("Current");

  const sjrLatest = latestCompleteSourceValue(detail?.sjr, "total_docs_year", lastCompleteYear);
  const incitesLatest = latestCompleteSourceValue(detail?.incites, "wos_documents", lastCompleteYear);
  const referenceCandidates = [sjrLatest, incitesLatest]
    .filter(Boolean)
    .map(item => ({ year: Number(item.year), value: Number(item.total_docs_year ?? item.wos_documents) }))
    .filter(item => Number.isFinite(item.value));
  const reference = referenceCandidates.sort((a, b) => b.year - a.year || b.value - a.value)[0] || null;
  const openAlexAtReference = reference
    ? series.find(item => Number(item.year) === reference.year)
    : null;

  const staleRecentCoverage = activeElsewhere && (!lastPositive || Number(lastPositive.year) < lastCompleteYear - 1);
  const strongMismatch = activeElsewhere && reference && reference.value >= 20
    && (!openAlexAtReference || Number(openAlexAtReference.works_count) < reference.value * 0.25);
  const incomplete = Boolean(staleRecentCoverage || strongMismatch);

  const reasons = [];
  if (staleRecentCoverage) {
    reasons.push(lastPositive
      ? `el último año con publicaciones recuperadas es ${lastPositive.year}`
      : "no se recuperaron publicaciones recientes");
  }
  if (strongMismatch && reference) {
    const oaValue = openAlexAtReference ? Number(openAlexAtReference.works_count) : 0;
    reasons.push(`para ${reference.year}, OpenAlex registra ${integerFormat(oaValue)} documentos frente a ${integerFormat(reference.value)} en otra fuente bibliométrica integrada`);
  }

  const explanation = incomplete
    ? `El registro enlazado no representa de forma suficiente la actividad reciente de la revista: ${reasons.join("; ")}. Puede existir fragmentación, desactualización o una asignación incompleta de publicaciones en OpenAlex. Por ello, la serie se conserva solo como referencia histórica y no se utiliza para calcular tendencias ni alertas.`
    : "La serie reciente de OpenAlex presenta continuidad suficiente para una lectura descriptiva complementaria.";

  return {
    incomplete,
    activeElsewhere,
    lastPositiveYear: lastPositive?.year || null,
    referenceYear: reference?.year || null,
    referenceValue: reference?.value || null,
    openAlexReferenceValue: openAlexAtReference ? Number(openAlexAtReference.works_count) : null,
    explanation
  };
}

function openAlexCoverageWarningHtml(assessment) {
  return `<div class="openalex-coverage-warning"><strong>Cobertura reciente incompleta en OpenAlex</strong><p>${escapeHtml(assessment.explanation)}</p></div>`;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function openAlexComplementaryEvaluationHtml(openalex, assessment = { incomplete: false }) {
  const currentYear = new Date().getFullYear();
  const series = sourceSeriesValues(openalex.production_by_year, "works_count");
  const currentYearPresent = series.some(item => Number(item.year) === currentYear);
  const latestComplete = latestCompleteSourceValue(openalex.production_by_year, "works_count", currentYear - 1);
  const baseline = series.filter(item => Number(item.year) >= currentYear - 6 && Number(item.year) <= currentYear - 2);
  const baselineMedian = median(baseline.map(item => Number(item.works_count)));
  let productionMetric;
  if (assessment.incomplete) {
    productionMetric = { label: "Producción OpenAlex", value: "Cobertura reciente incompleta", note: "La serie recuperada no representa de forma suficiente la actividad actual; no se calcula crecimiento ni disminución.", tone: "incomplete" };
  } else if (latestComplete && baseline.length >= 3 && baselineMedian >= 20) {
    const ratio = Number(latestComplete.works_count) / baselineMedian;
    productionMetric = { label: `Producción OpenAlex ${latestComplete.year}`, value: `${numberFormat(ratio)} veces`, note: `${latestComplete.year}: ${integerFormat(latestComplete.works_count)} · mediana ${baseline[0].year}–${baseline.at(-1).year}: ${integerFormat(baselineMedian)}. Comparación descriptiva; aún no modifica la categoría pública.`, tone: "available" };
  } else if (series.length) {
    const range = `${series[0].year}–${series.at(-1).year}`;
    productionMetric = { label: "Producción OpenAlex", value: "Información insuficiente para evaluar", note: `Existe una serie ${range}, pero no cumple los mínimos de años o volumen para la comparación ${currentYear - 1}.`, tone: "limited" };
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
  const firstSeriesYear = Number(series[0]?.year || 0);
  const lastSeriesYear = Number(series.at(-1)?.year || 0);
  const lastCompleteYear = currentYear - 1;
  const temporalNote = lastSeriesYear && lastSeriesYear < lastCompleteYear
    ? `OpenAlex registra información entre ${firstSeriesYear || stableStart} y ${lastSeriesYear}. Como no dispone de datos para ${lastSeriesYear + 1}–${lastCompleteYear}, la serie no se utiliza para evaluar una tendencia actual.`
    : `${stableStart ? `Serie sostenida desde ${stableStart}. ` : ""}${currentYearPresent ? `El año ${currentYear} se muestra como dato en curso y no se usa para comparar años completos.` : "La serie dispone de información hasta el último año completo."}`;
  const seriesMetric = assessment.incomplete
    ? { label: "Uso de la serie OpenAlex", value: "Solo referencia histórica", note: "La trayectoria se conserva para trazabilidad, pero no interviene en la evaluación reciente.", tone: "incomplete" }
    : series.length
      ? { label: "Cobertura temporal OpenAlex", value: `${series.length} años con registros`, note: temporalNote, tone: "available" }
      : { label: "Cobertura temporal OpenAlex", value: "Dato no reportado", note: "No se identificó una secuencia anual de publicaciones.", tone: "missing" };

  const retractions = Array.isArray(openalex.retracted_works) ? openalex.retracted_works : [];
  const retractionMetric = retractions.length
    ? { label: "Obras marcadas como retractadas", value: integerFormat(retractions.length), note: "Son registros de detección que requieren verificación con la fuente editorial o una base especializada.", tone: "warning" }
    : { label: "Retracciones en OpenAlex", value: "Consulta exhaustiva pendiente", note: "La carga básica actual no consulta de forma exhaustiva todas las obras retractadas; no debe interpretarse como cero retractaciones.", tone: "pending" };

  const notice = assessment.incomplete
    ? "Cobertura reciente incompleta"
    : currentYearPresent ? `Año ${currentYear} en curso` : "";
  const metrics = [productionMetric, seriesMetric, metadataMetric, retractionMetric];
  return `<div class="openalex-evaluation">
    <div class="openalex-evaluation-heading"><div><span>Evaluación complementaria inicial</span><strong>Indicadores descriptivos de OpenAlex</strong><small>Estos indicadores son complementarios y no modifican por sí solos el resultado cuantitativo.</small></div>${notice ? `<em class="openalex-heading-notice">${escapeHtml(notice)}</em>` : ""}</div>
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
  const firstYear = Number(complete[0].year);
  const lastYear = Number(complete.at(-1).year);
  const lastCompleteYear = currentYear - 1;
  const historical = lastYear < lastCompleteYear;
  const heading = historical
    ? `Lectura descriptiva del periodo disponible ${firstYear}–${lastYear}`
    : "Lectura descriptiva de la serie reciente";
  const limitation = historical
    ? " Esta trayectoria es histórica y no permite establecer el comportamiento actual de la revista."
    : "";
  return `<div class="openalex-narrative"><strong>${escapeHtml(heading)}</strong><p>La mayor producción anual del periodo mostrado se registró en ${escapeHtml(String(peak.year))}, con ${integerFormat(peak.works_count)} documentos.${trend}${oa} Las citas de los años más recientes deben interpretarse considerando su menor tiempo de acumulación.${limitation}</p></div>`;
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
    if (flag.code === "incomplete_recent_coverage") {
      return flag.message || "La cobertura reciente de OpenAlex es incompleta y no se utiliza para evaluar tendencias.";
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
  let badge = '<span class="section-result-badge neutral">No ejecutada</span>';

  if (!complementary) {
    content = `<div class="automated-status not-run"><span>Estado</span><strong>No ejecutada</strong></div>`;
  } else if (!evidence.length) {
    badge = '<span class="section-result-badge positive">Sin hallazgos</span>';
    content = `<div class="automated-status no-results"><span>Resultado</span><strong>Sin hallazgos en las consultas automatizadas ejecutadas</strong></div>`;
  } else {
    badge = '<span class="section-result-badge observed">Hallazgos localizados</span>';
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
      ${badge}
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
