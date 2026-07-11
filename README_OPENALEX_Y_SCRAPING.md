# Paquete piloto OpenAlex y evidencias

Este paquete añade al repositorio del Observatorio un flujo manual de GitHub Actions para:

1. Resolver revistas en OpenAlex por ISSN/eISSN.
2. Recuperar producción y citas por año, acceso abierto, temas, países, instituciones, autores y obras marcadas como retractadas.
3. Consultar Crossref para identificar correcciones, retractaciones y otras actualizaciones registradas.
4. Realizar un scraping limitado de páginas editoriales públicas, respetando `robots.txt` y dejando toda evidencia pendiente de revisión humana.

## Importante

- La clave se toma del secreto `OPENALEX_API_KEY`; nunca se escribe en los archivos.
- OpenAlex es una fuente bibliométrica complementaria, no una fuente oficial de indexación.
- El scraping no declara automáticamente que una revista sea problemática.
- Los resultados del piloto se guardan en `data/openalex`, `data/evidencias` y `data/piloto`.

## Instalación

Copie en la raíz del repositorio las carpetas `.github`, `config`, `scripts` y `data` incluidas aquí. Cuando Windows pregunte si desea combinar la carpeta `data`, acepte. No se reemplazan los archivos actuales del Verificador.

Después haga commit y push desde GitHub Desktop.

## Ejecución

En GitHub:

1. Abra **Actions**.
2. Seleccione **Piloto OpenAlex y evidencias**.
3. Pulse **Run workflow**.
4. Mantenga `30` revistas y `run_scraping = true`.
5. Pulse nuevamente **Run workflow**.

El flujo puede tardar varios minutos. Cuando termine, los resultados se incorporarán automáticamente al repositorio y también quedarán disponibles como artefacto descargable.

## Si el commit automático falla

En **Settings → Actions → General → Workflow permissions**, seleccione **Read and write permissions** y guarde. Luego vuelva a ejecutar el flujo.


## Cambios de la revisión 1.1
- Corrige las consultas Crossref que devolvían HTTP 400 por un campo no admitido en `select`.
- Añade una consulta específica para avisos de retractación.
- Diferencia páginas editoriales reales de páginas de desafío, bloqueo o error 404.
- Añade información de candidatos en cruces ambiguos de OpenAlex.
- Genera un resumen crítico con errores y limitaciones del piloto.
