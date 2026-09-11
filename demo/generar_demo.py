#!/usr/bin/env python3
"""Genera sesiones de DEMOSTRACION para ilustrar la app Kaax.

Los numeros no son inventados sueltos: se derivan unos de otros igual que en la
app real, si no los Reportes se contradicen entre si.
  distancia total = suma de la distancia de cada robot
  velocidad media = promedio PONDERADO por muestras, no media de medias
  area barrida    = distancia x swathMeters (0.9 m)
  area cuadrantes = celdas x lado^2 (10 m -> 100 m2)
Cada sesion lleva demo:true para poder borrarlas luego sin tocar las reales.
"""
import json, random
from datetime import datetime, timedelta

random.seed(20260911)                       # reproducible
SWATH, CELL = 0.9, 10
ROBOTS = [("01", "Kaax 1"), ("02", "Kaax 2"), ("03", "Kaax 3")]

OPERADORES = ["Diego Quezada", "Yael García", "Carvajal"]
SITIOS = [
    ("Laguna de Ojo de Agua - orilla norte", 19.6841, -99.0223),
    ("Laguna de Ojo de Agua - canal este",   19.6825, -99.0198),
    ("Presa Tecamac - vaso principal",       19.6902, -99.0310),
]
CLIMAS = ["Despejado 24 °C, viento 8 km/h", "Nublado 21 °C, viento 14 km/h",
          "Soleado 27 °C, viento 5 km/h", "Parcialmente nublado 23 °C, viento 11 km/h"]

NOTAS = [
    "Sargazo acumulado contra la orilla por el viento del norte.",
    "Mucho lirio en el canal; los rodillos se atascaron dos veces.",
    "Jornada limpia, sin incidencias. El robot 02 rindio mejor de lo habitual.",
    "Se perdio fix GPS unos minutos bajo los arboles de la ribera.",
    "Bastante PET y unicel flotando cerca del desague.",
    "Agua muy quieta; buen dia para cubrir area.",
    "Se corto temprano por lluvia.",
    "Primera salida con los rodillos nuevos: empujan mejor el material.",
]

def sesion(i, dia, n_robots, minutos, km_h_base, mezcla, nota, sitio, clima):
    inicio = dia
    dur_s = int(minutos * 60)
    fin = inicio + timedelta(seconds=dur_s)

    robots, dist_total, spd_sum_total, spd_n_total = {}, 0.0, 0.0, 0
    for idx, (rid, nombre) in enumerate(ROBOTS):
        if idx >= n_robots:      # robot que no salio ese dia
            robots[rid] = {"name": nombre, "dist": 0, "spdSum": 0, "spdN": 0,
                           "spdMax": 0, "battMin": None, "samples": 0, "avg": 0}
            continue
        kmh = round(km_h_base * random.uniform(.85, 1.15), 2)
        activo = dur_s * random.uniform(.78, .96)          # no todo el rato avanza
        dist = kmh / 3.6 * activo                          # m
        spd_n = int(activo)                                # ~1 muestra/s con fix
        robots[rid] = {
            "name": nombre, "dist": round(dist, 1),
            "spdSum": round(kmh * spd_n, 1), "spdN": spd_n,
            "spdMax": round(kmh * random.uniform(1.25, 1.6), 2),
            "battMin": None,                               # sin ADS1115, no se mide
            "samples": int(dur_s), "avg": kmh,
        }
        dist_total += dist; spd_sum_total += kmh * spd_n; spd_n_total += spd_n

    avg = round(spd_sum_total / spd_n_total, 3) if spd_n_total else 0
    swept = dist_total * SWATH
    celdas = max(1, int(swept / (CELL * CELL) * random.uniform(.55, .8)))

    # El peso guarda relacion con el area barrida, si no las graficas mienten.
    kg_tot = swept * random.uniform(0.0048, 0.0092)
    pesos = {k: round(kg_tot * v, 1) for k, v in mezcla.items()}

    return {
        "id": int(inicio.timestamp() * 1000),
        "start": int(inicio.timestamp() * 1000),
        "end": int(fin.timestamp() * 1000),
        "site": sitio[0],
        "ops": random.choice(OPERADORES),
        "user": OPERADORES[i % len(OPERADORES)],
        "notes": "DEMO — " + nota,
        "robots": robots,
        "cellsStart": 0,
        "gridKey": f"{sitio[1]:.5f}_{sitio[2]:.5f}_10_12x10",
        "detections": {"sargazo": int(celdas * 2.1), "lirio": int(celdas * .8),
                       "basura": int(celdas * .5)},
        "weights": pesos,
        "stats": {
            "dur": dur_s,
            "dist": round(dist_total, 1),
            "avg": avg,
            "swept": round(swept, 1),
            "cellsArea": celdas * CELL * CELL,
            "cells": celdas,
            "active": n_robots,
        },
        "weather": clima,
        "zone": {"lat": sitio[1], "lon": sitio[2]},
        "demo": True,
    }

# Diez jornadas en cinco semanas, con una mejora gradual del rendimiento:
# mas robots, mas minutos y algo mas de velocidad conforme avanza el proyecto.
PLAN = [
    (28, 1,  52, 1.6, {"sargazo": .55, "lirio": .30, "basura": .15}),
    (26, 1,  74, 1.7, {"sargazo": .48, "lirio": .38, "basura": .14}),
    (23, 2,  96, 1.8, {"sargazo": .62, "lirio": .24, "basura": .14}),
    (21, 2, 110, 1.9, {"sargazo": .58, "lirio": .28, "basura": .14}),
    (17, 2,  63, 1.7, {"sargazo": .51, "lirio": .33, "basura": .16}),
    (14, 3, 128, 2.0, {"sargazo": .66, "lirio": .21, "basura": .13}),
    (11, 3, 142, 2.1, {"sargazo": .70, "lirio": .18, "basura": .12}),
    ( 7, 3, 121, 2.0, {"sargazo": .64, "lirio": .23, "basura": .13}),
    ( 4, 3, 155, 2.2, {"sargazo": .72, "lirio": .16, "basura": .12}),
    ( 2, 3, 138, 2.3, {"sargazo": .68, "lirio": .19, "basura": .13}),
]

hoy = datetime(2026, 9, 11, 8, 0, 0)
out = []
for i, (dias_atras, nrob, mins, kmh, mezcla) in enumerate(PLAN):
    dia = hoy - timedelta(days=dias_atras)
    dia = dia.replace(hour=random.choice([7, 8, 9, 16]), minute=random.choice([0, 15, 30, 45]))
    out.append(sesion(i, dia, nrob, mins, kmh,
                      mezcla, NOTAS[i % len(NOTAS)],
                      SITIOS[i % len(SITIOS)], CLIMAS[i % len(CLIMAS)]))

out.sort(key=lambda s: s["start"])
print(json.dumps(out, ensure_ascii=False, indent=1))
