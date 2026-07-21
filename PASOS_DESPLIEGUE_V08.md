# Despliegue rápido de la versión 0.8

## Antes de copiar

1. Conserva una copia local del repositorio publicado.
2. Crea una rama o etiqueta de respaldo, por ejemplo `respaldo-v07`.
3. Revisa `audit/cambios_publicacion_v07_a_v08.csv`, especialmente los dos cambios a alerta alta.

## Actualización con GitHub Desktop

1. Abre la carpeta local del repositorio del Observatorio.
2. Copia el contenido del paquete `repo_v08` a la raíz del repositorio.
3. Asegúrate de copiar también la carpeta oculta `.github`.
4. Revisa los cambios en GitHub Desktop.
5. Usa un mensaje como: `Actualizar metodología y capa OpenAlex a v0.8`.
6. Haz `Commit to main` y luego `Push origin`.
7. En GitHub, verifica que Pages publique desde `main /docs`.

## Clave OpenAlex

En el repositorio:

`Settings → Secrets and variables → Actions → New repository secret`

Nombre exacto:

`OPENALEX_API_KEY`

Si el secreto ya existe con ese nombre, no es necesario recrearlo.

## Primera ejecución

1. Abre `Actions`.
2. Selecciona `Actualizar OpenAlex por lotes`.
3. Ejecuta primero un lote de **100 revistas**.
4. Verifica:
   - que el workflow termine correctamente;
   - que `data_openalex_queue.csv` cambie;
   - que aparezcan archivos en `data/openalex/results/`;
   - que se actualice `docs/data/openalex/status.json`;
   - que la clave no aparezca en archivos o logs.
5. Después ejecuta el lote diario predeterminado de **2 000**.
6. Durante un periodo de pago puede usarse un lote manual de **5 000**, vigilando duración y presupuesto.

## Funcionamiento posterior

- El workflow se ejecuta diariamente.
- Solo procesa estados `pending` o `error` con menos de cuatro intentos.
- Las revistas `completed`, `not_found` y `ambiguous` no se repiten automáticamente.
- Antes de cada bloque consulta `/rate-limit` y se detiene antes de agotar el presupuesto.

## Sincronización con la SQLite maestra

Después de descargar el repositorio actualizado:

```bash
python scripts/import_openalex_to_sqlite.py \
  --database observatorio_revistas_v0_8.sqlite \
  --results-dir data/openalex/results \
  --queue data_openalex_queue.csv
```

Esto incorpora los resultados completados y envía las vinculaciones ambiguas a `openalex_identity_review_v08`.

## Reversión

Si el despliegue presenta un problema:

1. Restaura la rama o etiqueta `respaldo-v07`.
2. Haz push de la versión anterior.
3. No borres la cola OpenAlex: puede conservarse para retomar el procesamiento cuando se corrija el problema.
