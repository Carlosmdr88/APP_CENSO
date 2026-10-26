'use strict';
const $ = id => document.getElementById(id);
const DISTRITOS = ['CARMEN','MERCED','HOSPITAL','CATEDRAL','ZAPOTE','SAN FRANCISCO DE DOS RÍOS','URUCA','MATA REDONDA','PAVAS','HATILLO','SAN SEBASTIÁN','OTRO'];
const CAMPOS = 'id,nombre_completo,numero_documento,fecha_nacimiento,creado_en,nacionalidad,distrito_registro,motivo_registro,tipo_documento';
const MIME = {'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp'};
let db, profile=null, stream=null, photoBlob=null, photoURL=null, photoVersion=0;
let records=[], pending=null, backupPending=null, backupSelection=[], previewURLs=[], busy=false, returnPage='personas';
let contextVersion=0, detailId=null, disabledBefore=[];
const upper = v => String(v || '').trim().toLocaleUpperCase('es-CR');
const documento = v => upper(v).replace(/[\s-]+/g,'');
const localHoy = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Costa_Rica'}).format(new Date());
function fechaISO(texto) {
    const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
    if(!m) throw Error('La fecha de nacimiento debe tener formato DD/MM/AAAA.');
    const [,d,mes,a]=m, date=new Date(`${a}-${mes}-${d}T12:00:00Z`);
    const iso=`${a}-${mes}-${d}`;
    if(!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==iso || iso<'1900-01-01' || iso>localHoy())
        throw Error('Ingresá una fecha de nacimiento válida, entre 1900 y hoy.');
    return iso;
}
function fecha(v, hora=false) {
    if(!v) return 'NO REGISTRADO';
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.slice(8,10)+'/'+v.slice(5,7)+'/'+v.slice(0,4);
    const date=new Date(v);
    if(!Number.isFinite(date.getTime())) return 'NO REGISTRADO';
    return new Intl.DateTimeFormat('es-CR',{timeZone:'America/Costa_Rica',day:'2-digit',month:'2-digit',year:'numeric',...(hora?{hour:'2-digit',minute:'2-digit',hour12:false}:{})}).format(date);
}
function elemento(tag, texto, clase) {
    const e=document.createElement(tag); if(texto!==undefined)e.textContent=texto; if(clase)e.className=clase; return e;
}
function boton(texto, accion, clase='secondary') { const b=elemento('button',texto,clase); b.type='button'; b.onclick=accion; return b; }
function message(t) { $('toast').textContent=t; $('toast').hidden=false; clearTimeout(message.timer); message.timer=setTimeout(()=>$('toast').hidden=true,10000); }
function errorText(e) { return e?.code==='23505'?'Ya existe ese tipo y número de identificación.':e?.message || 'No se pudo completar la operación.'; }
function setWorking(valor) {
    busy=valor;
    if(valor) { disabledBefore=[...$('workspace').querySelectorAll('button,input,select')].map(e=>[e,e.disabled]); disabledBefore.forEach(([e])=>e.disabled=true); }
    else {
        disabledBefore.forEach(([e,prev])=>{if(e.isConnected)e.disabled=prev;}); disabledBefore=[];
        // Si hay un guardado parcial, mantener sus datos hasta completar el reintento.
        $('form').querySelectorAll('input,select').forEach(e=>e.disabled=Boolean(pending));
        ['clearBackups','cameraBtn','uploadBtn','file'].forEach(id=>$(id).disabled=Boolean(pending||backupPending));
    }
}
function stop() { stream?.getTracks().forEach(t=>t.stop()); stream=null; $('video').srcObject=null; $('video').hidden=true; $('captureBtn').hidden=true; $('cameraBtn').hidden=false; }
function cleanPreviews() {previewURLs.forEach(u=>URL.revokeObjectURL(u)); previewURLs=[]; $('backupPreview').replaceChildren();}
function clearPhoto() {photoBlob=null; photoVersion++; if(photoURL)URL.revokeObjectURL(photoURL); photoURL=null; $('photo').removeAttribute('src'); $('photo').hidden=true; $('file').value=''; $('camHint').hidden=false;}
function clearResult(text='Tomá o subí una fotografía para comenzar.') { $('result').replaceChildren(elemento('p',text)); }
function lock() {
    profile=null; stop(); $('workspace').inert=true; $('login').hidden=false;
    records=[]; $('records').replaceChildren(); $('logs').replaceChildren(); $('detailContent').replaceChildren();
    clearPhoto(); clearResult(); cleanPreviews(); backupSelection=[]; pending=null; backupPending=null; detailId=null;
    $('form').reset(); $('contextForm').reset(); ['query','register'].forEach(toggleOther); $('register').hidden=true;
    document.querySelector('#profile span:nth-child(2)').textContent='Usuario autorizado';
}
async function authorize(user) {
    const {data,error}=await db.from('usuarios_autorizados').select('id,nombre,rol,activo').eq('id',user.id).eq('activo',true).maybeSingle();
    if(error)throw error; if(!data)throw Error('Tu cuenta no está autorizada o está inactiva.');
    profile=data; $('workspace').inert=false; $('login').hidden=true;
    document.querySelector('#profile span:nth-child(2)').textContent=data.nombre+' · '+data.rol;
}
async function guard() {
    const {data,error}=await db.auth.getUser();
    if(error||!data.user) {if(!pending&&!backupPending)lock(); throw Error('La sesión venció. Volvé a ingresar antes de continuar.');}
    await authorize(data.user); return data.user;
}
async function solicitarMotor(ruta, opciones={}) {
    const {data,error}=await db.auth.getSession();
    if(error||!data.session) throw Error('La sesión venció. Volvé a ingresar.');
    const control=new AbortController(), timer=setTimeout(()=>control.abort(),60000);
    const headers={...opciones.headers,Authorization:`Bearer ${data.session.access_token}`};
    try {
        const r=await fetch((CENSO_CONFIG.motorUrl||'http://127.0.0.1:8000')+ruta,{...opciones,method:'POST',headers,signal:control.signal});
        let result; try {result=await r.json();} catch {throw Error('El motor no devolvió una respuesta válida.');}
        if(!r.ok)throw Error(typeof result.detail==='string'?result.detail:'No se pudo completar la operación del motor.');
        return result;
    } catch(e) {if(e.name==='AbortError')throw Error('El motor superó el tiempo de espera. Podés reintentar.'); if(e instanceof TypeError)throw Error('No se pudo conectar con el motor. Revisá que Python esté encendido y CORS permita esta dirección.'); throw e;}
    finally {clearTimeout(timer);}
}
function toggleOther(prefijo) {
    const otro=$(prefijo==='query'?'queryDistrict':'registerDistrict').value==='OTRO';
    $(prefijo+'OtherWrap').hidden=!otro; $(prefijo+'Other').required=otro;
    if(!otro)$(prefijo+'Other').value='';
}
function distrito(prefijo) {
    const elegido=$(prefijo==='query'?'queryDistrict':'registerDistrict').value;
    if(!DISTRITOS.includes(elegido))throw Error('Seleccioná el distrito.');
    const otro=upper($(prefijo+'Other').value);
    if(elegido==='OTRO'&&otro.length<2)throw Error('Especificá el otro lugar.');
    return elegido==='OTRO'?'OTRO: '+otro:elegido;
}
function contexto() {
    if(!$('contextForm').reportValidity())return null;
    return {distrito:distrito('query'),motivo:upper($('queryReason').value)};
}
function photo(blob) {
    if(busy||pending||backupPending)return message('Completá la operación pendiente antes de cambiar la foto.');
    if(!MIME[blob.type]||blob.size>10485760)return message('Usá JPG, PNG o WebP de hasta 10 MB.');
    photoBlob=blob; photoVersion++; clearResult('Fotografía nueva. Indicá distrito y motivo y pulsá Buscar.');
    if(photoURL)URL.revokeObjectURL(photoURL); photoURL=URL.createObjectURL(blob); $('photo').src=photoURL; $('photo').hidden=false; $('camHint').hidden=true; stop();
}
function datosPersona(p) {
    const d=elemento('div',undefined,'datos');
    [['Nombre completo',upper(p.nombre_completo)],['Identificación',upper(p.numero_documento)],['Fecha de nacimiento',fecha(p.fecha_nacimiento)],['Fecha del primer registro',fecha(p.creado_en)],['Nacionalidad',upper(p.nacionalidad)]].forEach(([label,value])=>{
        const item=elemento('p'); item.append(elemento('small',label),elemento('strong',value||'NO REGISTRADO'));d.append(item);
    }); return d;
}
async function page(name) {
    if(!profile)return; if(busy)return message('Esperá a que termine la operación.');
    ['consulta','personas','historial','ficha'].forEach(id=>$(id).hidden=id!==name);
    document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===name));
    $('title').textContent={consulta:'Nueva consulta',personas:'Personas registradas',historial:'Historial de consultas',ficha:'Ficha de la persona'}[name];
    $('subtitle').textContent={consulta:'Fotografía, lugar y motivo de consulta.',personas:'Datos, fotografías e historial por persona.',historial:'Hasta 200 búsquedas recientes. Solo las confirmadas se vinculan a personas.',ficha:'Primer registro, consultas confirmadas y fotografías.'}[name];
    if(name!=='consulta')stop(); const uid=profile.id;
    try {
        if(name==='personas') {
            $('records').textContent='Cargando registros…';let all=[],offset=0;
            while(true) {const {data,error}=await db.from('personas').select(CAMPOS).order('creado_en',{ascending:false}).order('id').range(offset,offset+499);if(error)throw error;all.push(...data);offset+=data.length;if(!data.length)break;}
            if(profile?.id!==uid)return; records=all;render();
        }
        if(name==='historial') {
            $('logs').textContent='Cargando historial…';const r=await solicitarMotor('/historial');if(profile?.id!==uid)return;
            $('logs').replaceChildren();if(!r.consultas.length)$('logs').textContent='Todavía no hay consultas registradas.';
            r.consultas.forEach(c=>{const row=elemento('div',undefined,'row');row.append(elemento('strong',fecha(c.creado_en,true)+' · '+(c.lugar||'NO REGISTRADO')),elemento('p',c.motivo),elemento('small',c.persona_id?'VINCULADA A UNA PERSONA':c.resultado==='error'?'ERROR DE BÚSQUEDA':'SIN PERSONA CONFIRMADA'));if(c.persona_id)row.append(boton('Ver persona',()=>openDetail(c.persona_id,'historial')));$('logs').append(row);});
        }
    }catch(e){if(profile?.id===uid)message(errorText(e));}
}
function render() {
    const q=upper($('filter').value);$('records').replaceChildren();
    records.filter(p=>(upper(p.nombre_completo)+' '+upper(p.numero_documento)).includes(q)).forEach(p=>{
        const row=elemento('div',undefined,'row');row.append(datosPersona(p),boton('Abrir ficha, fotos e historial',()=>openDetail(p.id)));$('records').append(row);
    }); if(!$('records').children.length)$('records').textContent='Sin registros que coincidan con la búsqueda.';
}
async function buscar() {
    if(busy)return; if(!profile||!db)return message('Primero iniciá sesión.');if(!photoBlob)return message('Tomá o subí una fotografía.');
    let ctx;try{ctx=contexto();}catch(e){return message(e.message);}if(!ctx)return;
    const uid=profile.id, version=photoVersion, cv=contextVersion, blob=photoBlob;
    clearResult('Buscando…');setWorking(true);
    try {
        const form=new FormData();form.append('foto',blob,'consulta.jpg');form.append('motivo',ctx.motivo);form.append('distrito',ctx.distrito);
        const r=await solicitarMotor('/buscar',{body:form});if(profile?.id!==uid||version!==photoVersion||cv!==contextVersion)return;
        const box=$('result');box.replaceChildren(elemento('p',`Posibles candidatos · Filtro provisional ${r.umbral}. La similitud no confirma identidad.`));
        if(!r.candidatos.length)box.append(elemento('p','No se devolvieron candidatos con el filtro actual. Esto no garantiza que la persona no esté registrada.'));
        r.candidatos.forEach(p=>{
            const card=elemento('div',undefined,'result');card.append(datosPersona(p),elemento('p','Similitud: '+Number(p.similitud).toFixed(4)));
            card.append(boton('Ver ficha y fotografías',()=>openDetail(p.persona_id,'consulta')));
            const confirmar=boton('Confirmar registro y guardar consulta',async()=>{
                if(busy)return;
                if(photoVersion!==version||contextVersion!==cv)return message('La consulta cambió. Realizá una nueva búsqueda.');
                if(!window.confirm(`¿Confirmás que la persona consultada corresponde al registro ${p.nombre_completo}? Revisá antes la ficha, la identificación y las fotos.`))return;
                setWorking(true);
                try {await solicitarMotor(`/consultas/${r.consulta_id}/confirmar`,{headers:{'Content-Type':'application/json'},body:JSON.stringify({persona_id:p.persona_id})});
                    card.querySelectorAll('[data-confirmar]').forEach(b=>b.remove()); confirmar.remove();
                    // Una consulta solo puede vincularse a una persona.
                    box.querySelectorAll('[data-confirmar]').forEach(b=>{b.disabled=true;b.textContent='CONSULTA YA VINCULADA';});
                    message('Consulta vinculada al historial de la persona.');
                }catch(e){message(e.message);}finally{setWorking(false);if(box.isConnected)box.querySelectorAll('[data-confirmar]').forEach(b=>{if(b.textContent==='CONSULTA YA VINCULADA')b.disabled=true;});}
            },'');confirmar.dataset.confirmar='1';card.append(confirmar);box.append(card);
        });
    }catch(e){if(profile?.id===uid&&version===photoVersion){clearResult('No se pudo completar la búsqueda.');message(e.message);}}
    finally{setWorking(false);}
}
function historialTabla(persona, consultas) {
    const wrap=elemento('div',undefined,'tabla-scroll'), table=elemento('table',undefined,'historia');
    const head=elemento('thead'), hr=elemento('tr');['Evento','Fecha y hora (Costa Rica)','Distrito / lugar','Motivo'].forEach(t=>hr.append(elemento('th',t)));head.append(hr);table.append(head);
    const body=elemento('tbody');const eventos=[{tipo:'PRIMER REGISTRO',creado_en:persona.creado_en,lugar:persona.distrito_registro,motivo:persona.motivo_registro},...consultas.map(c=>({...c,tipo:'CONSULTA CONFIRMADA'}))];
    eventos.forEach(e=>{const r=elemento('tr');[e.tipo,fecha(e.creado_en,true),e.lugar||'NO REGISTRADO',e.motivo||'NO REGISTRADO'].forEach(v=>r.append(elemento('td',v)));body.append(r);});table.append(body);wrap.append(table);return wrap;
}
async function openDetail(id, from='personas') {
    if(busy)return; if(backupPending&&backupPending.personaId!==id)return message('Terminá primero la carga pendiente de respaldos.');
    if(!profile)return;const uid=profile.id;returnPage=from;detailId=id;await page('ficha');$('detailContent').textContent='Cargando ficha…';
    try {
        const r=await solicitarMotor(`/personas/${id}/detalle`);if(profile?.id!==uid||detailId!==id)return;
        const box=$('detailContent');box.replaceChildren(datosPersona(r.persona),elemento('h2','Fotografía principal'));
        const principal=elemento('div',undefined,'galeria'), respaldos=elemento('div',undefined,'galeria');
        r.fotografias.forEach(f=>{const fig=elemento('figure'),img=elemento('img');img.src=f.url;img.alt=f.tipo==='principal'?'Fotografía principal':'Fotografía de respaldo';const link=elemento('a');link.href=f.url;link.target='_blank';link.rel='noopener noreferrer';link.append(img);fig.append(link,elemento('figcaption',f.tipo==='principal'?'PRINCIPAL · RECONOCIMIENTO':'RESPALDO · SOLO CONSULTA VISUAL'));(f.tipo==='principal'?principal:respaldos).append(fig);});
        if(!principal.children.length)principal.textContent='Sin fotografía principal.';
        box.append(principal,elemento('h2','Fotos de respaldo (máximo 3)'),respaldos);
        const cantidad=r.fotografias.filter(f=>f.tipo==='respaldo').length;
        if(cantidad<3||backupPending) {
            const label=elemento('label',`Adjuntar respaldos: ${cantidad}/3 guardados`),input=elemento('input');input.type='file';input.multiple=true;input.accept=Object.keys(MIME).join(',');
            label.append(input);box.append(label);
            input.onchange=()=>{if(busy||backupPending){input.value='';return message('Completá la carga pendiente primero.');}try {const files=validarRespaldos(input.files,3-cantidad);if(files.length)guardarRespaldos(id,files);}catch(e){message(e.message);input.value='';}};
            if(backupPending)box.append(boton('Reintentar respaldos pendientes',()=>guardarRespaldos(id,[])));
        }else box.append(elemento('p','Ya se guardaron los 3 respaldos permitidos.'));
        box.append(elemento('h2','Historial de esta persona'),historialTabla(r.persona,r.historial));
    }catch(e){if(profile?.id===uid&&detailId===id){$('detailContent').textContent='No se pudo cargar la ficha.';message(e.message);}}
}
function validarRespaldos(files,max=3) {
    const list=[...files];if(list.length>max)throw Error(`Solo podés adjuntar ${max} foto(s) de respaldo adicional(es).`);
    if(list.some(f=>!MIME[f.type]||f.size>10485760))throw Error('Cada respaldo debe ser JPG, PNG o WebP de hasta 10 MB.');
    return list;
}
function nuevaFoto(personaId,blob,tipo) {const id=crypto.randomUUID();return {id,personaId,blob,tipo,path:personaId+'/'+id+MIME[blob.type],uploaded:false,saved:false};}
async function subirFoto(item,uid) {
    if(!item.uploaded) {
        const r=await db.storage.from('fotos-personas').upload(item.path,item.blob,{contentType:item.blob.type,upsert:false});
        if(r.error){const probe=await db.storage.from('fotos-personas').createSignedUrl(item.path,10);if(probe.error)throw r.error;}item.uploaded=true;
    }
    if(!item.saved) {
        const r=await db.from('fotografias').insert({id:item.id,persona_id:item.personaId,ruta_storage:item.path,tipo:item.tipo,creado_por:uid});
        if(r.error) {const exists=await db.from('fotografias').select('id').eq('id',item.id).maybeSingle();if(exists.error||!exists.data)throw r.error;}item.saved=true;
    }
}
async function guardarRespaldos(id,files) {
    if(busy)return;if(pending)return message('Terminá primero el registro pendiente.');
    if(!profile)return;setWorking(true);
    try {
        await guard();if(backupPending&&(backupPending.uid!==profile.id||backupPending.personaId!==id))throw Error('La carga pendiente pertenece a otra ficha o usuario.');
        if(!backupPending)backupPending={uid:profile.id,personaId:id,fotos:files.map(f=>nuevaFoto(id,f,'respaldo'))};
        for(const item of backupPending.fotos)await subirFoto(item,backupPending.uid);
        backupPending=null;message('Fotos de respaldo guardadas. No participan en reconocimiento.');
    }catch(e){message('Carga pendiente. Conservá esta página y usá Reintentar. '+errorText(e));}
    finally{setWorking(false);}
    // Refresca también al fallar para mostrar lo ya guardado y el botón de reintento.
    await openDetail(id,returnPage);
}
async function guardarPersona(event) {
    event.preventDefault();if(busy||!profile)return;if(backupPending)return message('Terminá la carga pendiente de respaldos.');
    if(!photoBlob)return message('Tomá o subí la fotografía principal.');
    const form=$('form');if(!form.reportValidity())return;let values;
    try {const f=form.elements;values={nombre_completo:upper(f.nombre.value),numero_documento:documento(f.identificacion.value),fecha_nacimiento:fechaISO(f.fecha.value),nacionalidad:upper(f.nacionalidad.value),tipo_documento:f.tipo.value,distrito_registro:distrito('register'),motivo_registro:upper(f.motivo.value)};
        if(!values.nombre_completo||!values.numero_documento||values.nacionalidad.length<2||!values.motivo_registro)throw Error('Completá todos los campos.');
    }catch(e){return message(e.message);}
    setWorking(true);let completo=false;
    try {
        await guard();if(pending&&pending.uid!==profile.id)throw Error('La operación pendiente pertenece a otra sesión.');
        if(!pending){const fd=new FormData();fd.append('foto',photoBlob,'principal.jpg');await solicitarMotor('/validar_foto',{body:fd});
            const id=crypto.randomUUID();pending={uid:profile.id,id,values:{...values,creado_por:profile.id},personSaved:false,principal:nuevaFoto(id,photoBlob,'principal'),respaldos:backupSelection.map(b=>nuevaFoto(id,b,'respaldo')),descriptorSaved:false};}
        const p=pending;
        if(!p.personSaved) {
            const r=await db.from('personas').insert({id:p.id,...p.values});
            if(r.error){const exists=await db.from('personas').select('id').eq('id',p.id).maybeSingle();if(exists.error||!exists.data){if(r.error.code==='23505')pending=null;throw r.error;}}
            p.personSaved=true;
        }
        await subirFoto(p.principal,p.uid);
        if(!p.descriptorSaved){const r=await solicitarMotor(`/fotografias/${p.principal.id}/descriptor`);if(!r.descriptor_guardado)throw Error('El descriptor no quedó guardado.');p.descriptorSaved=true;}
        for(const item of p.respaldos)await subirFoto(item,p.uid);
        pending=null;clearPhoto();form.reset();toggleOther('register');backupSelection=[];cleanPreviews();$('backupFiles').value='';$('register').hidden=true;clearResult();completo=true;
        message('Persona, foto principal, descriptor y respaldos guardados correctamente.');
    }catch(e){message((pending?'Guardado pendiente. No cierres esta página; pulsá Guardar para reintentar. ':'')+errorText(e));}
    finally{setWorking(false);}
    if(completo)await page('personas');
}
// Configuración de formularios.
['query','register'].forEach(prefijo=>{
    const sel=$(prefijo==='query'?'queryDistrict':'registerDistrict');sel.append(new Option('SELECCIONÁ EL DISTRITO',''));
    DISTRITOS.forEach(d=>sel.append(new Option(d,d)));sel.onchange=()=>toggleOther(prefijo);
});
document.querySelectorAll('[data-upper]').forEach(input=>input.addEventListener('input',()=>{
    const pos=input.selectionStart,prev=input.value;input.value=input.hasAttribute('data-documento')?documento(prev):prev.toLocaleUpperCase('es-CR');
    if(pos!==null){const removed=prev.length-input.value.length;const next=Math.max(0,pos-removed);input.setSelectionRange(next,next);}
}));
$('form').elements.fecha.addEventListener('input',e=>{const v=e.target.value.replace(/\D/g,'').slice(0,8);e.target.value=v.slice(0,2)+(v.length>2?'/'+v.slice(2,4):'')+(v.length>4?'/'+v.slice(4):'');});
$('contextForm').onsubmit=e=>e.preventDefault();$('contextForm').addEventListener('input',()=>{contextVersion++;clearResult('Los datos de consulta cambiaron. Realizá una nueva búsqueda.');});
$('loginForm').onsubmit=async e=>{e.preventDefault();if(!db)return message('No se cargó Supabase. Revisá Internet y recargá.');const b=e.target.querySelector('button');b.disabled=true;try{const {data,error}=await db.auth.signInWithPassword({email:$('email').value.trim(),password:$('password').value});if(error)throw Error('Revisá el correo y la contraseña.');await authorize(data.user);$('password').value='';await page('consulta');message('Sesión iniciada.');}catch(e){await db.auth.signOut({scope:'local'});lock();message(errorText(e));}finally{b.disabled=false;}};
$('logout').onclick=async()=>{if(busy||pending||backupPending)return message('Completá primero la operación pendiente.');const {error}=await db.auth.signOut({scope:'local'});if(error)return message(errorText(error));lock();};
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));$('filter').oninput=render;
$('newPerson').onclick=()=>{if(busy||!profile)return;if(!pending){$('form').elements.motivo.value=upper($('queryReason').value);$('registerDistrict').value=$('queryDistrict').value;toggleOther('register');$('registerOther').value=upper($('queryOther').value);}$('register').hidden=false;$('register').scrollIntoView({behavior:'smooth'});};
$('cancel').onclick=()=>{if(busy||pending)return message('Completá el registro pendiente.');$('form').reset();toggleOther('register');backupSelection=[];cleanPreviews();$('register').hidden=true;};
$('cameraBtn').onclick=async()=>{if(!profile||busy||pending||backupPending)return message('Terminá la operación pendiente.');try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});$('video').srcObject=stream;$('video').hidden=false;$('captureBtn').hidden=false;$('cameraBtn').hidden=true;}catch(e){message('No se pudo abrir la cámara. Revisá el permiso o subí una fotografía.');}};
$('captureBtn').onclick=()=>{const v=$('video');if(!v.videoWidth)return;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);c.toBlob(b=>{if(b)photo(b);},'image/jpeg',.85);};
$('uploadBtn').onclick=()=>$('file').click();$('file').accept=Object.keys(MIME).join(',');$('file').onchange=e=>{const f=e.target.files[0];if(f)photo(f);};
$('backupFiles').onchange=e=>{if(busy||pending){e.target.value='';return message('Completá primero el registro pendiente.');}try{backupSelection=validarRespaldos(e.target.files);cleanPreviews();backupSelection.forEach(f=>{const img=elemento('img');img.alt='Vista previa de respaldo';img.src=URL.createObjectURL(f);previewURLs.push(img.src);$('backupPreview').append(img);});}catch(err){e.target.value='';backupSelection=[];cleanPreviews();message(err.message);}};
$('clearBackups').onclick=()=>{if(busy||pending)return message('Completá primero el registro pendiente.');backupSelection=[];$('backupFiles').value='';cleanPreviews();};
$('form').onsubmit=guardarPersona;$('searchBtn').disabled=false;$('searchBtn').textContent='Buscar posibles coincidencias';$('searchBtn').onclick=buscar;
$('closeDetail').onclick=()=>page(returnPage);
window.addEventListener('pagehide',stop);window.addEventListener('beforeunload',e=>{if(pending||backupPending||busy){e.preventDefault();e.returnValue='';}});
(async()=>{try{if(!window.supabase)throw Error('No se cargó Supabase. Revisá Internet.');db=window.supabase.createClient(CENSO_CONFIG.url,CENSO_CONFIG.key,{auth:{persistSession:false,detectSessionInUrl:false}});db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'&&!busy&&!pending&&!backupPending)lock();});}catch(e){lock();message(errorText(e));}})();
