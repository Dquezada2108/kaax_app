# Datos de demostración

`sesiones_demo.json` son **diez jornadas inventadas** para enseñar la app con
los Reportes llenos. No son mediciones reales.

## Importar

Reportes → **Importar** → elige `sesiones_demo.json`.

Se quedan **solo en ese navegador**: el botón Importar escribe en
`localStorage` y no llama a `pushSession`, así que no se suben al equipo en
Firebase ni contaminan los reportes compartidos.

## Borrar cuando ya no las necesites

Cada sesión lleva `demo: true`. En la consola del navegador (F12), estando en
la app:

```js
const k = "kaax.sessions";
const all = JSON.parse(localStorage.getItem(k) || "[]");
const quedan = all.filter(s => !s.demo);
localStorage.setItem(k, JSON.stringify(quedan));
console.log("borradas", all.length - quedan.length, "· quedan", quedan.length);
location.reload();
```

Eso respeta tus sesiones reales: solo quita las marcadas.

## Regenerar con otros números

`generar_demo.py` deriva unas cifras de otras igual que la app, para que los
Reportes no se contradigan:

| Campo | De dónde sale |
|---|---|
| distancia total | suma de la distancia de cada robot |
| velocidad media | promedio **ponderado** por muestras, no media de medias |
| área barrida | distancia × `swathMeters` (0.9 m) |
| área por cuadrantes | celdas × lado² (10 m → 100 m²) |
| duración | fin − inicio |
| kg | proporcional al área barrida |

```bash
python3 demo/generar_demo.py > demo/sesiones_demo.json
```

El rendimiento en kg es lo único que **no** está anclado a nada real: no sé
cuánto recoge tu robot de verdad. Está puesto en 7–14 kg por robot-hora, que
es deliberadamente conservador. Ajusta el `random.uniform(0.0048, 0.0092)`
(kg por m² barrido) cuando tengas una medición real.
