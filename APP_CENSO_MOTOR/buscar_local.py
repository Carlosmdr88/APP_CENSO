from pathlib import Path

import cv2
import numpy as np

from procesar_fotos import db
from motor_facial import generar_descriptor, MODELO


def buscar():
    ruta = input("Ruta de la fotografía: ").strip().strip('"')
    archivo = Path(ruta)

    if not archivo.is_file():
        print("No se encontró el archivo.")
        return

    contenido = archivo.read_bytes()

    if len(contenido) > 10 * 1024 * 1024:
        print("La fotografía supera los 10 MB.")
        return
    try:
        consulta = generar_descriptor(contenido)
    except ValueError as error:
        print(error)
        return

    
    resultados = []
    inicio = 0

    while True:
        filas = (
            db.table("descriptores_faciales")
            .select("fotografia_id,descriptor")
            .eq("modelo", MODELO)
            .order("id")
            .range(inicio, inicio + 499)
            .execute()
            .data
        )

        if not filas:
            break

        for fila in filas:
            vector = np.asarray(
                fila["descriptor"], dtype=np.float32
            )
            norma = np.linalg.norm(vector)

            if (
                vector.shape != (128,)
                or not np.isfinite(vector).all()
                or norma == 0
            ):
                continue

            similitud = float(
                np.clip(np.dot(consulta, vector / norma), -1, 1)
            )

            resultados.append(
                (similitud, fila["fotografia_id"])
            )

        inicio += len(filas)

    resultados.sort(reverse=True)

    if not resultados:
        print("No hay descriptores disponibles para comparar.")
        return

    print("\nResultados ordenados por similitud:")
    print("Son candidatos de prueba, no identidades confirmadas.\n")

    for similitud, foto_id in resultados[:3]:
        foto = (
            db.table("fotografias")
            .select("persona_id")
            .eq("id", foto_id)
            .execute()
            .data
        )

        if not foto:
            continue

        persona = (
            db.table("personas")
            .select("nombre_completo")
            .eq("id", foto[0]["persona_id"])
            .execute()
            .data
        )

        if persona:
            nombre = persona[0]["nombre_completo"]
            print(f"{nombre} | Similitud: {similitud:.4f}")


if __name__ == "__main__":
    buscar()