# Observatorio de Integridad Científica — actualización v0.8

Fecha de construcción: 20 de julio de 2026  
Base de origen: `observatorio_revistas_v0_7.sqlite`  
Universo: 61 807 revistas

## 1. Objetivo

Publicar rápidamente una versión metodológicamente más sólida sin abandonar GitHub Pages ni introducir infraestructura externa. La versión 0.8 corrige la mezcla entre coberturas bibliométricas y prepara un enriquecimiento progresivo con la API de OpenAlex.

## 2. Correcciones metodológicas

### Separación por proveedor

- **Scopus oficial / Elsevier:** estado y cobertura oficial.
- **SCImago, basado en datos de Scopus:** producción anual, SJR, cuartil SJR, áreas y categorías SCImago.
- **Web of Science / InCites / JCR:** producción WoS, autocitación de la fuente, CNCI, JIF, JIF sin autocitas, JCI y cuartiles WoS.
- **OpenAlex:** fuente complementaria abierta. No reemplaza indicadores comerciales.

### Producción

Se eliminó como regla final la selección del mayor valor entre SCImago e InCites. Ahora existen:

- `production_signal_scimago`
- `production_signal_incites`
- `production_concordance`

Las dos fuentes conservan su propia elegibilidad, taxonomía disciplinar y umbrales. La coincidencia aumenta la consistencia interpretativa, pero los ratios no se promedian ni se fusionan.

### SJR

Se incorporó una trayectoria propia:

- SJR 2025.
- Mediana SJR 2020–2024.
- Ratio de cambio.
- Cambio absoluto.
- Cuartil SJR 2025.
- Señal contextual de variación.

La variación SJR no eleva por sí sola la categoría pública.

## 3. Distribución v0.8

| Resultado cuantitativo | Revistas |
|---|---:|
| No aplicable al modelo actual | 29 262 |
| Sin señales cuantitativas | 20 516 |
| Evaluación limitada | 10 709 |
| Alerta moderada | 1 290 |
| Alerta alta | 30 |

Se registran 47 cambios respecto de v0.7:

- 36 pasan de “Sin señales cuantitativas” a “Alerta moderada”.
- 9 pasan de “Alerta moderada” a “Sin señales cuantitativas”.
- 2 pasan de “Alerta moderada” a “Alerta alta”.

Los dos cambios a alerta alta son:

1. `INTERNATIONAL JOURNAL OF INFORMATION TECHNOLOGIES AND SYSTEMS APPROACH`: producción InCites moderada y autocitación de la fuente moderada.
2. `Journal of Aeronautics, Astronautics and Aviation`: producción InCites moderada y autocitación de la fuente extrema.

La lista completa está en `audit/cambios_publicacion_v07_a_v08.csv`.

## 4. OpenAlex inicial

La implementación deliberadamente limitada incluye:

- resolución de fuente por ISSN;
- producción anual desde `counts_by_year`;
- producción 2025 / mediana 2020–2024;
- conteo y tasa de trabajos marcados como retractados;
- distribución de tipos documentales 2020–2025;
- control de identidades ambiguas.

OpenAlex permanece como capa complementaria y no modifica todavía la categoría pública.

### Protección de identidad

Cuando distintos ISSN de la misma revista conducen a OpenAlex Source IDs diferentes, la revista queda con estado `ambiguous`. No se elige automáticamente la fuente de mayor tamaño.

## 5. Arquitectura GitHub Pages

- `docs/data/search-index.json`: índice compacto de búsqueda.
- `docs/data/journals/`: 256 fragmentos de fichas.
- `docs/data/openalex/`: fragmentos OpenAlex generados progresivamente.
- `data_openalex_queue.csv`: cola persistente de 61 807 revistas.
- `.github/workflows/openalex-batch.yml`: ejecución diaria y manual.
- `scripts/openalex_batch.py`: consulta y control de presupuesto.
- `scripts/build_openalex_public.py`: reconstrucción de la capa pública.

Ningún archivo individual del repositorio supera 100 MB.

## 6. Bases entregadas

### Base maestra

`observatorio_revistas_v0_8.sqlite`

- Conserva las tablas históricas de v0.7.
- Añade `section2_decision_v08`.
- Añade `journal_metrics_by_source_v08`.
- Añade umbrales globales y por área v0.8.
- Añade cola y tablas de resultados OpenAlex.
- `PRAGMA user_version = 8`.
- Integridad SQLite: `ok`.

### Base compacta de publicación

`observatorio_publicacion_v0_8.sqlite`

Contiene únicamente resultados públicos, cambios, umbrales y cola OpenAlex. Facilita auditorías rápidas sin cargar la base histórica completa.

## 7. Limitaciones deliberadas

- No se incorporó CiteScore.
- No se implementaron redes de citación, carteles, CIDRE ni análisis semántico.
- No se descargaron PDF o textos completos.
- No se aplicaron señales OpenAlex a la clasificación pública.
- La cola OpenAlex empieza en 0 de 61 807 y debe ejecutarse con la clave del repositorio.

## 8. Estado de validación

- Integridad SQLite maestra: `ok`.
- Integridad SQLite compacta: `ok`.
- Scripts Python: compilación correcta.
- JavaScript: validación sintáctica correcta.
- JSON públicos: lectura correcta.
- Fragmentos de revistas: 256.
- Archivo público más grande: inferior a 1 MB por fragmento.
