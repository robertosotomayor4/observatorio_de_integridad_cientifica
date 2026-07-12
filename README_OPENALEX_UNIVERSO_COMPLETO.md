# OpenAlex para el universo completo — Observatorio de Integridad Científica

## Qué incorpora

Esta actualización amplía OpenAlex desde el piloto de 30 revistas a las 61 806 revistas del catálogo del Verificador.

La arquitectura tiene dos capas:

1. **Núcleo para todo el catálogo**
   - cruce por ISSN/eISSN;
   - identificación de la fuente OpenAlex;
   - documentos y citas acumuladas;
   - índice h;
   - producción y citas por año;
   - producción en acceso abierto;
   - control de registros históricos aislados.

2. **Enriquecimiento progresivo**
   - temas principales;
   - países con mayor presencia;
   - instituciones con mayor presencia.

El núcleo se genera en una única ejecución. El enriquecimiento continúa automáticamente cada día hasta completar las revistas que tengan una coincidencia válida en OpenAlex.

## Por qué se procesa en dos capas

El catálogo contiene 96 158 ISSN únicos. El núcleo puede resolverse en lotes de hasta 50 ISSN por consulta, por lo que cabe dentro del presupuesto gratuito diario de OpenAlex.

Los temas, países e instituciones requieren tres consultas adicionales por revista. Para respetar el presupuesto gratuito, el flujo procesa hasta 2 500 revistas por día y reanuda automáticamente al día siguiente. El tiempo total dependerá de cuántas revistas tengan una fuente válida en OpenAlex, pero normalmente será de varias semanas en el plan gratuito.

## Archivos incorporados

- `.github/workflows/openalex_universo_completo.yml`
- `scripts/openalex_full_common.py`
- `scripts/openalex_full_core.py`
- `scripts/openalex_full_enrich.py`
- `assets/app.js`
- `data/openalex_full/core/.gitkeep`
- `data/openalex_full/enriched/.gitkeep`

Los datos se publican fragmentados en 256 archivos pequeños y se cargan únicamente cuando el usuario abre una revista. La página inicial no descarga toda la base OpenAlex.

## Primera ejecución

1. Guardar `OPENALEX_API_KEY` como secreto del repositorio.
2. Confirmar `Settings → Actions → General → Workflow permissions → Read and write permissions`.
3. Abrir `Actions → OpenAlex — universo completo`.
4. Pulsar `Run workflow`.
5. Seleccionar:
   - `mode`: `bootstrap`
   - `max_enrichment`: `2000`
6. Ejecutar el flujo.

El modo `bootstrap` construye el núcleo completo y utiliza el presupuesto restante para iniciar el enriquecimiento.

## Operación posterior

No es necesario ejecutar manualmente el flujo cada día. La programación automática se activa a las 03:23 UTC y procesa hasta 2 500 revistas pendientes, respetando el presupuesto disponible de la clave.

Opciones manuales:

- `core`: reconstruye el núcleo para las 61 806 revistas.
- `enrich`: continúa únicamente el enriquecimiento.
- `bootstrap`: ejecuta núcleo y enriquecimiento inicial.

## Alcance

Esta automatización amplía **OpenAlex** al universo completo. Crossref, Retraction Watch y el scraping editorial permanecen priorizados para alertas y casos seleccionados; no se ejecutan indiscriminadamente sobre las 61 806 revistas.

## Interpretación

OpenAlex es una fuente bibliométrica abierta y complementaria. Sus datos no sustituyen el estado oficial de Scopus, Web of Science o DOAJ ni modifican automáticamente la escala cuantitativa del Observatorio.
