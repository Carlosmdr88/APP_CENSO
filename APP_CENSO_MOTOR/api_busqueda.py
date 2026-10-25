from threading import Lock

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from motor_facial import generar_descriptor, MODELO, MAX_BYTES
from procesar_fotos import db

from uuid import UUID
from procesar_fotos import procesar

router = APIRouter()
seguridad = HTTPBearer()
bloqueo_busqueda = Lock()


def usuario_autorizado(
    credencial: HTTPAuthorizationCredentials = Depends(seguridad)
):
    try:
        respuesta = db.auth.get_user(credencial.credentials)
    except Exception:
        raise HTTPException(401, "Sesión inválida o vencida.")

    if not respuesta.user:
        raise HTTPException(401, "Debés iniciar sesión.")

    try:
        filas = (
            db.table("usuarios_autorizados")
            .select("id")
            .eq("id", str(respuesta.user.id))
            .eq("activo", True)
            .limit(1)
            .execute()
            .data
        )
    except Exception:
        raise HTTPException(503, "No se pudo comprobar el acceso.")

    if not filas:
        raise HTTPException(403, "Usuario no autorizado.")

    return filas[0]["id"]


@router.post("/buscar")
def buscar(
    foto: UploadFile,
    usuario_id: str = Depends(usuario_autorizado)
):
    try:
        contenido = foto.file.read(MAX_BYTES + 1)
    finally:
        foto.file.close()

    try:
        consulta = generar_descriptor(contenido)
    except ValueError as error:
        raise HTTPException(400, str(error))

    try:
        with bloqueo_busqueda:
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

                    similitud = float(np.clip(
                        np.dot(consulta, vector / norma), -1, 1
                    ))
                if similitud >= 0.60:
                    resultados.append(
                        (similitud, fila["fotografia_id"])
                    )

                inicio += len(filas)

            resultados.sort(reverse=True)
            candidatos = []
            personas_vistas = set()

            for similitud, foto_id in resultados:
                fotos = (
                    db.table("fotografias")
                    .select("persona_id")
                    .eq("id", foto_id)
                    .execute()
                    .data
                )

                if not fotos:
                    continue

                persona_id = fotos[0]["persona_id"]

                if persona_id in personas_vistas:
                    continue

                personas = (
                    db.table("personas")
                    .select("id,nombre_completo")
                    .eq("id", persona_id)
                    .execute()
                    .data
                )

                if not personas:
                    continue

                personas_vistas.add(persona_id)
                candidatos.append({
                    "persona_id": persona_id,
                    "nombre": personas[0]["nombre_completo"],
                    "similitud": round(similitud, 4)
                })

                if len(candidatos) == 3:
                    break

        return {
            "modo": "prueba_sin_umbral",
            "identidad_confirmada": False,
            "candidatos": candidatos
        }

    except Exception:
        raise HTTPException(
            503, "No se pudo completar la búsqueda."
        )
@router.post("/validar_foto")
def validar_foto(
    foto: UploadFile,
    usuario_id: str = Depends(usuario_autorizado)
    ):
    try:
        contenido = foto.file.read(MAX_BYTES + 1)
    finally:
        foto.file.close()

    try:
        generar_descriptor(contenido)
    except ValueError as error:
        raise HTTPException(400, str(error))

    return {"foto_valida": True}


@router.post("/fotografias/{fotografia_id}/descriptor")
def guardar_descriptor(
    fotografia_id: UUID,
    usuario_id: str = Depends(usuario_autorizado)
):
    try:
        fotos = (
            db.table("fotografias")
            .select("id,ruta_storage,creado_por")
            .eq("id", str(fotografia_id))
            .limit(1)
            .execute()
            .data
        )

        if not fotos:
            raise HTTPException(404, "No se encontró la fotografía.")

        foto = fotos[0]

        # El operador puede procesar sus propias fotografías.
        # El administrador puede procesar cualquier registro.
        if foto["creado_por"] != usuario_id:
            administradores = (
                db.table("usuarios_autorizados")
                .select("id")
                .eq("id", usuario_id)
                .eq("activo", True)
                .eq("rol", "administrador")
                .limit(1)
                .execute()
                .data
            )

            if not administradores:
                raise HTTPException(
                    403, "No podés procesar esta fotografía."
                )

        with bloqueo_busqueda:
            procesar(foto)

        return {
            "descriptor_guardado": True,
            "fotografia_id": str(fotografia_id)
        }

    except HTTPException:
        raise

    except ValueError as error:
        raise HTTPException(400, str(error))

    except Exception:
        raise HTTPException(
            503,
            "No se pudo guardar el descriptor. Intentá nuevamente."
        )