from pathlib import Path
from threading import Lock
from api_busqueda import router
from fastapi.middleware.cors import CORSMiddleware

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, UploadFile

app = FastAPI(title="APP CENSO - Prueba local")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
        "http://127.0.0.1:5500",
        "http://localhost:5500"
    ],
    allow_methods=["POST"],
    allow_headers=["Authorization", "Content-Type"]
)
app.include_router(router)

BASE = Path(__file__).resolve().parent
bloqueo = Lock()

detector = cv2.FaceDetectorYN.create(
    str(BASE / "modelos" / "yunet.onnx"),
    "",
    (320, 320)
)

reconocedor = cv2.FaceRecognizerSF.create(
    str(BASE / "modelos" / "sface.onnx"),
    ""
)


@app.get("/salud")
def comprobar_servicio():
    return {
        "estado": "funcionando",
        "modelos": "cargados",
        "busqueda_en_base": "pendiente"
    }


@app.post("/detectar")
def detectar_rostro(foto: UploadFile):
    try:
        contenido = foto.file.read(10 * 1024 * 1024 + 1)
    finally:
        foto.file.close()

    if len(contenido) > 10 * 1024 * 1024:
        raise HTTPException(413, "La imagen supera los 10 MB.")

    imagen = cv2.imdecode(
        np.frombuffer(contenido, dtype=np.uint8),
        cv2.IMREAD_COLOR
    )

    if imagen is None:
        raise HTTPException(400, "No se pudo abrir la imagen.")

    alto, ancho = imagen.shape[:2]

    # Reducir fotografías grandes antes de procesarlas.
    escala = min(1.0, 1200 / max(alto, ancho))
    if escala < 1:
        imagen = cv2.resize(
            imagen,
            (max(1, round(ancho * escala)),
             max(1, round(alto * escala)))
        )

    alto, ancho = imagen.shape[:2]

    descriptor = None

    with bloqueo:
        detector.setInputSize((ancho, alto))
        _, rostros = detector.detect(imagen)

        if rostros is not None and len(rostros) == 1:
            rostro_alineado = reconocedor.alignCrop(
                imagen, rostros[0]
            )
            descriptor = reconocedor.feature(rostro_alineado)
    cantidad = 0 if rostros is None else len(rostros)

    return {
        "rostros_detectados": cantidad,
        "foto_apta_para_continuar": cantidad == 1,
        "descriptor_generado": descriptor is not None,
        "dimensiones": (
            int(descriptor.size) if descriptor is not None else 0
        )
    }