# Observatorio de Integridad Científica — actualización v0.8.2

## Objetivo

Actualizar la metodología cuantitativa y los datos auditados sin sustituir la interfaz pública aprobada del **Verificador de revistas**.

## Interfaz preservada

El archivo `index.html` es idéntico, byte por byte, al repositorio restaurado recibido. Se mantienen:

- título «Verificador de revistas»;
- encabezado, navegación y buscador;
- estructura y orden de la ficha;
- resumen de evaluación, estado en fuentes, cronología, gráficas y evaluación cualitativa;
- publicación de GitHub Pages desde `main / (root)`.

La única ampliación visual se encuentra dentro de **Evaluación cuantitativa**:

- bloque naranja **Scopus / SCImago**;
- bloque violeta **Web of Science / InCites**;
- OpenAlex continúa como bloque complementario independiente.

## Correcciones incorporadas

1. SCImago e InCites dejan de compartir un único indicador de producción basado en el mayor ratio.
2. Cada fuente conserva su producción, línea base, ratio, señal y cobertura.
3. La persistencia queda identificada expresamente como indicador SCImago.
4. Se incorpora la trayectoria del SJR, separada del JIF y del JCI.
5. Se mantienen en InCites la autocitación de la fuente, CNCI, JIF, JIF sin autocitas y JCI.
6. Los indicadores bibliométricos favorables solo se muestran cuando el resultado principal es «sin señales cuantitativas».
7. Se corrigen series históricas e identidades auditadas, incluidos British Journal of Surgery, Atmosphere y Atmosphere-Korea.
8. Se incorpora `Atmosphere-Korea` como identidad independiente, elevando el catálogo a 61 807 revistas.

## Resultados v0.8

| Resultado | Revistas |
|---|---:|
| No aplicable | 29 262 |
| Sin señales cuantitativas | 20 516 |
| Evaluación limitada | 10 709 |
| Alerta moderada | 1 290 |
| Alerta alta | 30 |

Comparada con la versión actualmente publicada —metodología 0.6—, cambian 54 estados cuantitativos y se añade una revista. El archivo `audit_v08/cambios_publicacion_v07_a_v08.csv` documenta los cambios de la última transición metodológica.

## OpenAlex

El repositorio recibido ya contenía una cobertura básica OpenAlex para las 61 806 revistas anteriores:

- 56 454 cruces automáticos;
- 1 cruce manual;
- 112 casos ambiguos;
- 5 239 no encontrados;
- 22 000 revistas con enriquecimiento de temas, países e instituciones al momento del respaldo.

Esta cobertura se conserva. El workflow actualizado detecta cambios en el catálogo: si el núcleo OpenAlex no coincide con el número de revistas o está incompleto, lo sincroniza antes de continuar el enriquecimiento. La clave permanece en `OPENALEX_API_KEY`, dentro de los secretos de GitHub Actions.

## Validaciones

- 61 807 identificadores únicos en el catálogo.
- 256 fragmentos de detalle y 61 807 fichas.
- JSON y copias `.gz` equivalentes.
- JavaScript sin errores sintácticos.
- HTML y YAML analizables.
- scripts Python compilables.
- ningún archivo individual supera 100 MiB.
- no se detectó una clave OpenAlex expuesta.
- `index.html` no fue modificado.
