from pathlib import Path
from threading import Lock

import cv2
import numpy as np

BASE = Path(__file__).resolve().parent
MODELO = "sface_2021dec"
MAX_BYTES = 10 * 1024 * 1024

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


def generar_descriptor(contenido: bytes):
    if not contenido:
        raise ValueError("La imagen está vacía.")

    if len(contenido) > MAX_BYTES:
        raise ValueError("La imagen supera los 10 MB.")

    imagen = cv2.imdecode(
        np.frombuffer(contenido, dtype=np.uint8),
        cv2.IMREAD_COLOR
    )

    if imagen is None:
        raise ValueError("No se pudo abrir la imagen.")

    alto, ancho = imagen.shape[:2]

    # Misma escala para registrar y buscar.
    escala = min(1.0, 640 / max(alto, ancho))

    if escala < 1:
        imagen = cv2.resize(
            imagen,
            (
                max(1, round(ancho * escala)),
                max(1, round(alto * escala))
            ),
            interpolation=cv2.INTER_AREA
        )

    alto, ancho = imagen.shape[:2]

    with bloqueo:
        detector.setInputSize((ancho, alto))
        _, rostros = detector.detect(imagen)

        cantidad = 0 if rostros is None else len(rostros)

        if cantidad != 1:
            raise ValueError(
                f"Se detectaron {cantidad} rostros; se necesita uno."
            )

        alineado = reconocedor.alignCrop(imagen, rostros[0])
        vector = reconocedor.feature(alineado).flatten()

    if vector.size != 128 or not np.isfinite(vector).all():
        raise ValueError("El descriptor no es válido.")

    norma = np.linalg.norm(vector)

    if norma == 0:
        raise ValueError("El descriptor está vacío.")

    return (vector / norma).astype(np.float32)