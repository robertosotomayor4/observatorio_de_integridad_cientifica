# Observatorio de Integridad Científica — interfaz v0.8.1

## Alcance

Esta versión es un ajuste exclusivamente visual sobre los datos y la metodología cuantitativa v0.8.

## Cambios realizados

- Se mantiene una sola sección denominada **Indicadores cuantitativos por fuente**.
- Dentro de esa sección se presentan dos subbloques paralelos:
  - **Scopus / SCImago**, con acento naranja.
  - **Web of Science / InCites**, con acento azul.
- Cada subbloque conserva únicamente los indicadores de su propio ecosistema.
- La lectura de concordancia entre fuentes aparece debajo de ambos bloques y se identifica como corroboración, no como métrica fusionada.
- OpenAlex permanece en un bloque complementario independiente.
- Se actualiza la identificación del portal a **interfaz v0.8.1 · datos/metodología v0.8**.

## Elementos no modificados

- 61 807 registros de revistas.
- Categorías públicas y resultados cuantitativos.
- Umbrales globales y disciplinares.
- Fórmulas.
- Archivos de fichas de revistas.
- Cola y resultados OpenAlex.
- Workflow de GitHub Actions.
- Scripts de actualización.
- Bases SQLite v0.8.

## Archivos de interfaz modificados

- `docs/index.html`
- `docs/assets/app.js`
- `docs/assets/styles.css`
- `docs/data/summary.json` — solo metadatos de versión de interfaz.
- `docs/metodologia.html`
- `README.md`
