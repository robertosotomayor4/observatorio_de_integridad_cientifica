# Observatorio de Integridad Científica — v0.8.1

Actualización visual y metodológica para GitHub Pages. Mantiene la estructura funcional de la v0.8 y separa de forma concreta los indicadores SCImago/Scopus y Web of Science/InCites dentro de la ficha.


## Ajuste visual v0.8.1

- Se conserva una sola sección de evaluación cuantitativa.
- Dentro de ella aparecen dos subbloques paralelos: **Scopus / SCImago** y **Web of Science / InCites**.
- Cada subbloque mantiene su color, denominación, indicadores y nota de cobertura.
- OpenAlex permanece como información complementaria separada.
- No se modificaron resultados, umbrales, SQLite ni la cola OpenAlex de la v0.8.

## Cambios principales

- SCImago y Web of Science/InCites ya no se fusionan mediante el mayor ratio.
- Cada fuente conserva su población, categorías, umbrales, ratio y señal.
- La persistencia histórica está rotulada explícitamente como SCImago.
- El SJR se muestra como trayectoria propia y señal contextual.
- OpenAlex se procesa por lotes desde GitHub Actions y no altera todavía la categoría pública.
- Los datos públicos están fragmentados en 256 archivos para evitar un JSON monolítico.

## Publicación

GitHub Pages debe apuntar a la carpeta `/docs` de la rama principal.

## Clave OpenAlex

Crear el secreto del repositorio:

`Settings → Secrets and variables → Actions → New repository secret`

Nombre exacto: `OPENALEX_API_KEY`

La clave no debe copiarse dentro de HTML, JavaScript, CSV o JSON público.

## Primera carga

Ejecutar `Actions → Actualizar OpenAlex por lotes → Run workflow`.

- Con la opción gratuita, el lote diario predeterminado es 2 000 revistas; el script consulta el presupuesto antes y durante la ejecución y se detiene antes de agotarlo.
- Durante un periodo de pago, puede ejecutarse manualmente un lote de 5 000 o más, respetando el tiempo máximo de GitHub Actions. Antes de la carga masiva conviene ejecutar una prueba de 100 revistas.
- La cola conserva el progreso; las revistas completadas no se descargan de nuevo.
- Si varios ISSN conducen a fuentes OpenAlex distintas, el registro queda como `ambiguous` y no se fusiona automáticamente.

## Archivos principales

- `docs/`: web pública.
- `data_openalex_queue.csv`: cola de 61 807 revistas.
- `data/openalex/results/`: resultados crudos resumidos por lote.
- `scripts/openalex_batch.py`: consulta API y actualiza la cola.
- `scripts/build_openalex_public.py`: genera la capa pública OpenAlex.
