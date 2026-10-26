import logging
import os
from threading import Lock
from uuid import UUID

import numpy as np
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

from motor_facial import generar_descriptor, MODELO, MAX_BYTES
from procesar_fotos import db, procesar

router = APIRouter()
seguridad = HTTPBearer()
bloqueo_busqueda = Lock()
logger = logging.getLogger(__name__)
UMBRAL = float(os.environ.get('CENSO_UMBRAL_PRUEBA', '0.60'))
if not np.isfinite(UMBRAL) or not -1 <= UMBRAL <= 1:
    raise RuntimeError('CENSO_UMBRAL_PRUEBA debe estar entre -1 y 1.')
CAMPOS_PERSONA = 'id,nombre_completo,numero_documento,fecha_nacimiento,creado_en,nacionalidad,distrito_registro,motivo_registro,tipo_documento'


def usuario_autorizado(credencial: HTTPAuthorizationCredentials = Depends(seguridad)):
    try:
        respuesta = db.auth.get_user(credencial.credentials)
    except Exception:
        raise HTTPException(401, 'Sesión inválida o vencida.')
    if not respuesta.user:
        raise HTTPException(401, 'Debés iniciar sesión.')
    try:
        filas = db.table('usuarios_autorizados').select('id,rol,nombre').eq('id', str(respuesta.user.id)).eq('activo', True).limit(1).execute().data
    except Exception:
        raise HTTPException(503, 'No se pudo comprobar el acceso.')
    if not filas:
        raise HTTPException(403, 'Usuario no autorizado.')
    return filas[0]['id']


def leer_foto(foto):
    try:
        return foto.file.read(MAX_BYTES + 1)
    finally:
        foto.file.close()


def contexto(motivo, distrito):
    motivo, distrito = motivo.strip().upper(), distrito.strip().upper()
    if not 1 <= len(motivo) <= 500 or not 2 <= len(distrito) <= 160:
        raise HTTPException(400, 'Indicá el distrito y el motivo de consulta.')
    return motivo, distrito


def buscar_candidatos(consulta):
    """Todas las filas se evalúan; solo se leen descriptores de fotos principales."""
    inicio = 0
    mejores = {}
    while True:
        filas = (db.table('descriptores_faciales')
                 .select('fotografia_id,descriptor,fotografias!inner(tipo,persona_id)')
                 .eq('modelo', MODELO).eq('fotografias.tipo', 'principal')
                 .order('id').range(inicio, inicio+499).execute().data)
        if not filas:
            break
        for fila in filas:
            foto = fila.get('fotografias') or {}
            if foto.get('tipo') != 'principal':
                continue
            vector = np.asarray(fila['descriptor'], dtype=np.float32)
            if vector.shape != (128,) or not np.isfinite(vector).all():
                continue
            norma = np.linalg.norm(vector)
            if norma == 0:
                continue
            similitud = float(np.clip(np.dot(consulta, vector / norma), -1, 1))
            if similitud >= UMBRAL:
                persona_id = foto['persona_id']
                mejores[persona_id] = max(mejores.get(persona_id, -1), similitud)
        inicio += len(filas)
    candidatos = []
    for persona_id, similitud in sorted(mejores.items(), key=lambda x: x[1], reverse=True)[:3]:
        personas = db.table('personas').select(CAMPOS_PERSONA).eq('id', persona_id).limit(1).execute().data
        if personas:
            candidatos.append({**personas[0], 'persona_id': persona_id,
                               'similitud': round(similitud, 4)})
    return candidatos


@router.post('/buscar')
def buscar(foto: UploadFile, motivo: str = Form(...), distrito: str = Form(...),
           usuario_id: str = Depends(usuario_autorizado)):
    motivo, distrito = contexto(motivo, distrito)
    try:
        vector = generar_descriptor(leer_foto(foto))
    except ValueError as error:
        raise HTTPException(400, str(error))
    consulta_id = None
    try:
        with bloqueo_busqueda:
            registrada = db.table('consultas').insert({
                'usuario_id': usuario_id, 'motivo': motivo, 'lugar': distrito,
                'resultado': 'pendiente', 'motor': 'opencv-sface',
                'version_modelo': MODELO, 'umbral': UMBRAL
            }).execute().data
            if not registrada:
                raise RuntimeError('Consulta sin identificador')
            consulta_id = registrada[0]['id']
            candidatos = buscar_candidatos(vector)
            db.rpc('censo_finalizar_consulta_v2', {
                'p_consulta': consulta_id, 'p_candidatos': candidatos
            }).execute()
        return {'consulta_id': consulta_id, 'modo': 'filtro_provisional',
                'umbral': UMBRAL, 'identidad_confirmada': False, 'candidatos': candidatos}
    except Exception as error:
        logger.error('Fallo de búsqueda: %s', type(error).__name__)
        if consulta_id:
            try:
                db.table('consultas').update({'resultado': 'error'}).eq('id', consulta_id).execute()
            except Exception:
                pass
        raise HTTPException(503, 'No se pudo completar y registrar la búsqueda. Revisá el motor y Supabase.')


class Confirmacion(BaseModel):
    persona_id: UUID


@router.post('/consultas/{consulta_id}/confirmar')
def confirmar(consulta_id: UUID, datos: Confirmacion, usuario_id: str = Depends(usuario_autorizado)):
    try:
        # La función SQL valida propietario, candidato e idempotencia bajo bloqueo.
        db.rpc('censo_confirmar_consulta_v2', {
            'p_consulta': str(consulta_id), 'p_persona': str(datos.persona_id),
            'p_usuario': usuario_id
        }).execute()
        return {'confirmada': True}
    except Exception as error:
        logger.warning('Confirmación rechazada: %s', type(error).__name__)
        raise HTTPException(409, 'No se pudo vincular. Debe ser un candidato de tu consulta y no estar vinculada a otra persona.')


@router.post('/validar_foto')
def validar_foto(foto: UploadFile, usuario_id: str = Depends(usuario_autorizado)):
    try:
        generar_descriptor(leer_foto(foto))
    except ValueError as error:
        raise HTTPException(400, str(error))
    return {'foto_valida': True}


@router.post('/fotografias/{fotografia_id}/descriptor')
def guardar_descriptor(fotografia_id: UUID, usuario_id: str = Depends(usuario_autorizado)):
    try:
        fotos = db.table('fotografias').select('id,tipo,creado_por').eq('id', str(fotografia_id)).limit(1).execute().data
        if not fotos:
            raise HTTPException(404, 'No se encontró la fotografía.')
        foto = fotos[0]
        if foto['tipo'] != 'principal':
            raise HTTPException(400, 'Las fotos de respaldo no participan en reconocimiento.')
        if foto['creado_por'] != usuario_id:
            admin = db.table('usuarios_autorizados').select('id').eq('id', usuario_id).eq('activo', True).eq('rol', 'administrador').limit(1).execute().data
            if not admin:
                raise HTTPException(403, 'No podés procesar esta fotografía.')
        with bloqueo_busqueda:
            procesar(foto)
        return {'descriptor_guardado': True, 'fotografia_id': str(fotografia_id)}
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(400, str(error))
    except Exception:
        raise HTTPException(503, 'No se pudo guardar el descriptor. Reintentá el guardado.')


def historial_persona(persona_id):
    filas, inicio = [], 0
    while True:
        lote = (db.table('consultas')
                .select('id,creado_en,motivo,lugar,confirmado_en,usuario_id')
                .eq('persona_id', persona_id).order('creado_en', desc=True).order('id')
                .range(inicio, inicio+499).execute().data)
        if not lote:
            break
        filas.extend(lote)
        inicio += len(lote)
    return filas


@router.post('/personas/{persona_id}/detalle')
def detalle(persona_id: UUID, usuario_id: str = Depends(usuario_autorizado)):
    try:
        pid = str(persona_id)
        personas = db.table('personas').select(CAMPOS_PERSONA).eq('id', pid).limit(1).execute().data
        if not personas:
            raise HTTPException(404, 'Persona no encontrada.')
        fotos = db.table('fotografias').select('id,tipo,ruta_storage,creado_en').eq('persona_id', pid).order('creado_en').execute().data
        galeria = []
        for foto in fotos:
            enlace = db.storage.from_('fotos-personas').create_signed_url(foto['ruta_storage'], 180)
            url = enlace.get('signedURL') or enlace.get('signedUrl')
            if not url:
                raise RuntimeError('No se obtuvo URL privada')
            galeria.append({'id': foto['id'], 'tipo': foto['tipo'], 'url': url})
        return {'persona': personas[0], 'fotografias': galeria,
                'historial': historial_persona(pid)}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'No se pudo abrir la ficha o su historial. Reintentá.')


@router.post('/historial')
def historial(usuario_id: str = Depends(usuario_autorizado)):
    try:
        usuarios = db.table('usuarios_autorizados').select('rol').eq('id', usuario_id).limit(1).execute().data
        query = db.table('consultas').select('id,creado_en,motivo,lugar,resultado,persona_id,usuario_id,confirmado_en')
        if not usuarios or usuarios[0]['rol'] != 'administrador':
            query = query.eq('usuario_id', usuario_id)
        return {'consultas': query.order('creado_en', desc=True).limit(200).execute().data}
    except Exception:
        raise HTTPException(503, 'No se pudo cargar el historial.')
