# Paquete piloto OpenAlex y evidencias v1.2

Esta revisión mantiene el piloto de 30 revistas y añade controles de calidad antes de integrar resultados en la web pública.

## Cambios principales

1. **Crossref depurado**
   - Conserva un archivo bruto para auditoría.
   - Genera `data/evidencias/crossref_events_clean.json` con eventos explícitos y deduplicados.
   - Separa correcciones y erratas (informativas) de retractaciones, expresiones de preocupación, retiros y removals (revisión prioritaria).

2. **Acta Cardiologica resuelta con trazabilidad**
   - Se incorpora `config/openalex_overrides.csv`.
   - La revista principal queda asociada al registro OpenAlex `S18670189`.
   - El segundo candidato corresponde al suplemento y no se combina automáticamente con la revista principal.

3. **Controles de calidad OpenAlex**
   - Marca coincidencias con baja similitud de título aunque el ISSN coincida.
   - Detecta registros aislados anteriores al inicio de la serie sostenida para evitar gráficas históricas engañosas.

4. **Resumen más útil**
   - Informa resultados brutos y depurados.
   - Cuenta eventos por tipo.
   - Registra banderas de calidad y cobertura real del scraping.

## Instalación

Copie en la raíz del repositorio:

- `.github`
- `config`
- `scripts`
- `README_OPENALEX_Y_SCRAPING.md`

Cuando Windows pregunte, acepte combinar carpetas y reemplazar archivos.

En GitHub Desktop use el resumen:

`Depura evidencias OpenAlex y Crossref v1.2`

Haga **Commit to main**, luego **Pull origin** si aparece y finalmente **Push origin**.

## Ejecución

En GitHub → Actions seleccione **Piloto OpenAlex y evidencias v1.2**, mantenga 30 revistas y scraping activado.

## Archivos de salida

- `data/openalex/pilot_openalex.json`
- `data/openalex/pilot_openalex_audit.csv`
- `data/evidencias/crossref_updates.json` (bruto)
- `data/evidencias/crossref_events_clean.json` (depurado)
- `data/evidencias/web_scraping_pilot.json`
- `data/piloto/resumen_piloto.md`

Los resultados siguen siendo preliminares y requieren revisión humana antes de mostrarse en el Verificador.
