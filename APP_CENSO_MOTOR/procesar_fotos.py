from pathlib import Path
from uuid import uuid4
import os
from dotenv import load_dotenv
from supabase import create_client
from motor_facial import generar_descriptor, MODELO

BASE = Path(__file__).resolve().parent
load_dotenv(BASE / '.env')
db = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVER_KEY'])


def procesar(foto):
    # Consultar el tipo en la base, nunca confiar en el dato enviado por el cliente.
    filas = db.table('fotografias').select('id,ruta_storage,tipo').eq('id', foto['id']).limit(1).execute().data
    if not filas:
        raise ValueError('Fotografía no encontrada.')
    actual = filas[0]
    if actual['tipo'] != 'principal':
        raise ValueError('Las fotos de respaldo no generan descriptores.')
    contenido = db.storage.from_('fotos-personas').download(actual['ruta_storage'])
    vector = generar_descriptor(contenido)
    existente = db.table('descriptores_faciales').select('id').eq('fotografia_id', actual['id']).limit(1).execute().data
    db.table('descriptores_faciales').upsert({
        'id': existente[0]['id'] if existente else str(uuid4()),
        'fotografia_id': actual['id'], 'modelo': MODELO, 'descriptor': vector.tolist()
    }, on_conflict='fotografia_id').execute()


def main():
    guardadas = revisar = errores = inicio = 0
    while True:
        fotos = db.table('fotografias').select('id').eq('tipo', 'principal').order('id').range(inicio, inicio+49).execute().data
        if not fotos:
            break
        for foto in fotos:
            try:
                procesar(foto)
                guardadas += 1
                print('Descriptor actualizado:', foto['id'])
            except ValueError as error:
                revisar += 1
                print('Revisar', foto['id'], ':', error)
            except Exception as error:
                errores += 1
                print('Error en', foto['id'], ':', type(error).__name__)
        inicio += len(fotos)
    print(f'Actualizadas: {guardadas} | Por revisar: {revisar} | Errores: {errores}')


if __name__ == '__main__':
    main()
