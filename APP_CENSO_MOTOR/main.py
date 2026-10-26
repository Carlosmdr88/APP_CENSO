from fastapi import FastAPI, Depends, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from api_busqueda import router, usuario_autorizado, leer_foto
from motor_facial import generar_descriptor, MODELO

app = FastAPI(title='APP CENSO - Registro y consultas', version='2.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://127.0.0.1:3000', 'http://localhost:3000',
        'http://127.0.0.1:5500', 'http://localhost:5500'
    ],
    allow_methods=['POST', 'GET'],
    allow_headers=['Authorization', 'Content-Type']
)
app.include_router(router)


@app.get('/salud')
def salud():
    return {'estado': 'funcionando', 'modelos': 'cargados', 'modelo': MODELO}


@app.post('/detectar')
def detectar(foto: UploadFile, usuario_id: str = Depends(usuario_autorizado)):
    try:
        vector = generar_descriptor(leer_foto(foto))
        return {'rostros_detectados': 1, 'foto_apta_para_continuar': True,
                'descriptor_generado': True, 'dimensiones': int(vector.size)}
    except ValueError as error:
        raise HTTPException(400, str(error))
