from pathlib import Path
from uuid import uuid4
import os

from dotenv import load_dotenv
from supabase import create_client

from motor_facial import generar_descriptor, MODELO

BASE = Path(__file__).resolve().parent
load_dotenv(BASE / ".env")

db = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVER_KEY"]
)


def procesar(foto):
    contenido = (
        db.storage.from_("fotos-personas")
        .download(foto["ruta_storage"])
    )

    vector = generar_descriptor(contenido)

    existente = (
        db.table("descriptores_faciales")
        .select("id")
        .eq("fotografia_id", foto["id"])
        .limit(1)
        .execute()
        .data
    )

    descriptor_id = (
        existente[0]["id"] if existente else str(uuid4())
    )

    db.table("descriptores_faciales").upsert(
        {
            "id": descriptor_id,
            "fotografia_id": foto["id"],
            "modelo": MODELO,
            "descriptor": vector.tolist()
        },
        on_conflict="fotografia_id"
    ).execute()


def main():
    guardadas = 0
    revisar = 0
    errores = 0
    inicio = 0

    while True:
        fotos = (
            db.table("fotografias")
            .select("id,ruta_storage")
            .order("id")
            .range(inicio, inicio + 49)
            .execute()
            .data
        )

        if not fotos:
            break

        for foto in fotos:
            try:
                procesar(foto)
                guardadas += 1
                print(f"Descriptor actualizado: {foto['id']}")

            except ValueError as error:
                revisar += 1
                print(f"Revisar {foto['id']}: {error}")

            except Exception as error:
                errores += 1
                print(
                    f"Error en {foto['id']}: "
                    f"{type(error).__name__}"
                )

        inicio += len(fotos)

    print(
        f"\nActualizadas: {guardadas}"
        f" | Por revisar: {revisar}"
        f" | Errores: {errores}"
    )


if __name__ == "__main__":
    main()