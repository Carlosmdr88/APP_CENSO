"use strict";
const $ = (id) => document.getElementById(id);
let db,
  profile = null,
  stream = null,
  photoBlob = null,
  photoURL = null,
  records = [],
  pending = null,
  busy = false;
function message(t) {
  $("toast").textContent = t;
  $("toast").hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => ($("toast").hidden = true), 8000);
}
function errorText(e) {
  if (e?.code === "23505")
    return "Ya existe un registro con esa identificación.";
  return e?.message || "No se pudo completar la operación. Revisá la conexión.";
}
function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("video").srcObject = null;
  $("video").hidden = true;
  $("captureBtn").hidden = true;
  $("cameraBtn").hidden = false;
}
function lock() {
  profile = null;
  stop();
  $("workspace").inert = true;
  $("login").hidden = false;
  $("records").replaceChildren();
  $("logs").replaceChildren();
  records = [];
  pending = null;
  photoBlob = null;
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = null;
  $("photo").removeAttribute("src");
  $("photo").hidden = true;
  $("form").reset();
  $("register").hidden = true;
  document.querySelector("#profile span:nth-child(2)").textContent =
    "Usuario autorizado";
}
async function authorize(user) {
  const { data, error } = await db
    .from("usuarios_autorizados")
    .select("id,nombre,rol,activo")
    .eq("id", user.id)
    .eq("activo", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Error("Tu cuenta no está autorizada o está inactiva.");
  profile = data;
  $("workspace").inert = false;
  $("login").hidden = true;
  document.querySelector("#profile span:nth-child(2)").textContent =
    data.nombre + " · " + data.rol;
  await page("consulta");
}
async function guard() {
  const { data, error } = await db.auth.getUser();
  if (error || !data.user) {
    lock();
    throw Error("Iniciá sesión para continuar.");
  }
  await authorize(data.user);
  return data.user;
}
async function page(name) {
  if (!profile) return;
  ["consulta", "personas", "historial"].forEach(
    (x) => ($(x).hidden = x !== name),
  );
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  $("title").textContent = {
    consulta: "Nueva consulta",
    personas: "Personas registradas",
    historial: "Historial de consultas",
  }[name];
  $("subtitle").textContent = {
    consulta: "Registro de personas y fotografía.",
    personas: "Consultá los registros guardados.",
    historial: "Consultas del servicio de reconocimiento.",
  }[name];
  if (name !== "consulta") stop();
  try {
    if (name === "personas") {
      const { data, error } = await db
        .from("personas")
        .select(
          "id,nombre_completo,numero_documento,fecha_nacimiento,nacionalidad",
        )
        .order("creado_en", { ascending: false })
        .limit(100);
      if (error) throw error;
      records = data;
      render();
    }
    if (name === "historial") {
      const { data, error } = await db
        .from("consultas")
        .select("creado_en,motivo,resultado")
        .order("creado_en", { ascending: false })
        .limit(100);
      if (error) throw error;
      $("logs").replaceChildren();
      if (!data.length)
        $("logs").textContent =
          "No hay consultas. El servicio facial aún está pendiente.";
      data.forEach((x) => {
        const el = document.createElement("div");
        el.className = "row";
        el.textContent =
          new Date(x.creado_en).toLocaleString("es-CR") +
          " · " +
          x.motivo +
          " · " +
          x.resultado;
        $("logs").append(el);
      });
    }
  } catch (e) {
    message(errorText(e));
  }
}
function render() {
  const q = $("filter").value.toLocaleLowerCase();
  $("records").replaceChildren();
  records
    .filter((x) =>
      (x.nombre_completo + " " + x.numero_documento)
        .toLocaleLowerCase()
        .includes(q),
    )
    .forEach((x) => {
      const row = document.createElement("div");
      row.className = "row";
      const title = document.createElement("strong");
      title.textContent = x.nombre_completo;
      const d = document.createElement("p");
      d.textContent =
        x.numero_documento +
        " · " +
        x.nacionalidad +
        " · " +
        x.fecha_nacimiento;
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = "Ver fotografías";
      b.onclick = () => photos(x.id, row);
      row.append(title, d, b);
      $("records").append(row);
    });
  if (!$("records").children.length)
    $("records").textContent =
      "Sin resultados. Se muestran los últimos 100 registros.";
}
async function photos(id, row) {
  try {
    row.querySelectorAll("img").forEach((i) => i.remove());
    const { data, error } = await db
      .from("fotografias")
      .select("ruta_storage")
      .eq("persona_id", id);
    if (error) throw error;
    if (!data.length)
      return message("La persona no tiene fotografías asociadas.");
    for (const f of data) {
      const r = await db.storage
        .from("fotos-personas")
        .createSignedUrl(f.ruta_storage, 60);
      if (r.error) throw r.error;
      const img = document.createElement("img");
      img.src = r.data.signedUrl;
      img.alt = "Fotografía del registro";
      img.style.cssText =
        "display:block;max-width:180px;max-height:180px;margin-top:12px";
      row.append(img);
    }
  } catch (e) {
    message(errorText(e));
  }
}
function photo(blob) {
  if (pending)
    return message(
      "Completá el guardado pendiente antes de cambiar la fotografía.",
    );
  photoBlob = blob;
  if (photoURL) URL.revokeObjectURL(photoURL);
  photoURL = URL.createObjectURL(blob);
  $("photo").src = photoURL;
  $("photo").hidden = false;
  $("camHint").hidden = true;
  stop();
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  if (!db) return message("No se cargó Supabase. Revisá Internet y recargá.");
  const b = e.target.querySelector("button");
  b.disabled = true;
  try {
    const { data, error } = await db.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });
    if (error)
      throw Error("No se pudo ingresar. Revisá el correo y la contraseña.");
    await authorize(data.user);
    $("password").value = "";
    message("Sesión iniciada.");
  } catch (e) {
    await db.auth.signOut({ scope: "local" });
    lock();
    message(errorText(e));
  } finally {
    b.disabled = false;
  }
};
$("logout").onclick = async () => {
  if (busy) return message("Esperá a que termine el guardado.");
  const { error } = await db.auth.signOut({ scope: "local" });
  lock();
  message(error ? errorText(error) : "Sesión cerrada.");
};
document
  .querySelectorAll("nav button")
  .forEach((b) => (b.onclick = () => page(b.dataset.page)));
$("filter").oninput = render;
$("newPerson").onclick = () => {
  if (profile) $("register").hidden = false;
};
$("cancel").onclick = () => {
  if (busy || pending)
    return message("Completá el guardado pendiente con el botón Guardar.");
  $("form").reset();
  $("register").hidden = true;
};
$("cameraBtn").onclick = async () => {
  if (!profile) return;
  if (pending) return message("Completá el guardado pendiente.");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    $("video").srcObject = stream;
    $("video").hidden = false;
    $("captureBtn").hidden = false;
    $("cameraBtn").hidden = true;
  } catch (e) {
    message(
      "No se pudo abrir la cámara. Revisá el permiso o subí una fotografía.",
    );
  }
};
$("captureBtn").onclick = () => {
  const v = $("video");
  if (!v.videoWidth) return;
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob(
    (b) => {
      if (b) photo(b);
    },
    "image/jpeg",
    0.85,
  );
};
$("uploadBtn").onclick = () => $("file").click();
$("file").accept = "image/jpeg,image/png,image/webp";
$("file").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(f.type) ||
    f.size > 10485760
  )
    return message("Seleccioná JPG, PNG o WebP de hasta 10 MB.");
  photo(f);
};
$("form").elements.fecha.max = new Date().toISOString().slice(0, 10);
$("form").onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  if (!profile) return;
  if (!photoBlob)
    return message("Tomá o subí una fotografía antes de guardar.");
  const form = e.target;
  const values = Object.fromEntries(new FormData(form));
  for (const k in values) values[k] = values[k].trim();
  if (
    !values.nombre ||
    !values.identificacion ||
    !values.pais ||
    !values.nacionalidad ||
    !values.motivo
  )
    return message("Completá todos los campos.");
  busy = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  const uid = profile.id;
  try {
    await guard();
    if (pending && pending.uid !== uid)
      throw Error("La operación pendiente pertenece a otra sesión.");
    if (!pending) {
      pending = {
        uid,
        id: crypto.randomUUID(),
        fileId: crypto.randomUUID(),
        personSaved: false,
        uploaded: false,
        photoSaved: false,
        values: {
          nombre_completo: values.nombre,
          numero_documento: values.identificacion,
          fecha_nacimiento: values.fecha,
          pais_documento: values.pais,
          tipo_documento: values.tipo,
          nacionalidad: values.nacionalidad,
          motivo_registro: values.motivo,
          creado_por: uid,
        },
      };
      pending.path =
        pending.id +
        "/" +
        pending.fileId +
        { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[
          photoBlob.type
        ];
    }
    const p = pending;
    if (!p.personSaved) {
      const r = await db.from("personas").insert({ id: p.id, ...p.values });
      if (r.error) {
        if (r.error.code === "23505") {
          const exists = await db
            .from("personas")
            .select("id")
            .eq("id", p.id)
            .maybeSingle();
          if (!exists.data) {
            pending = null;
            throw r.error;
          }
        } else throw r.error;
      }
      p.personSaved = true;
    }
    if (!p.uploaded) {
      const r = await db.storage
        .from("fotos-personas")
        .upload(p.path, photoBlob, {
          contentType: photoBlob.type,
          upsert: false,
        });
      if (r.error) {
        const probe = await db.storage
          .from("fotos-personas")
          .createSignedUrl(p.path, 10);
        if (probe.error) throw r.error;
      }
      p.uploaded = true;
    }
    if (!p.photoSaved) {
      const r = await db.from("fotografias").insert({
        id: p.fileId,
        persona_id: p.id,
        ruta_storage: p.path,
        creado_por: uid,
      });
      if (r.error) {
        const exists = await db
          .from("fotografias")
          .select("id")
          .eq("id", p.fileId)
          .maybeSingle();
        if (!exists.data) throw r.error;
      }
      p.photoSaved = true;
    }
    pending = null;
    photoBlob = null;
    if (photoURL) URL.revokeObjectURL(photoURL);
    photoURL = null;
    $("photo").hidden = true;
    $("photo").removeAttribute("src");
    $("file").value = "";
    form.reset();
    $("register").hidden = true;
    await page("personas");
    message("Persona y fotografía guardadas en Supabase.");
  } catch (e) {
    message(
      (pending
        ? "Guardado pendiente: no cierres esta página. Volvé a pulsar Guardar para reintentar. "
        : "") + errorText(e),
    );
  } finally {
    busy = false;
    btn.disabled = false;
  }
};
window.addEventListener("pagehide", stop);
window.addEventListener("beforeunload", (e) => {
  if (pending || busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});
(async () => {
  try {
    if (!window.supabase)
      throw Error("No se cargó Supabase. Revisá Internet y recargá.");
    db = window.supabase.createClient(CENSO_CONFIG.url, CENSO_CONFIG.key, {
      auth: { persistSession: false, detectSessionInUrl: false },
    });
    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") lock();
    });
    const { data, error } = await db.auth.getUser();
    if (!error && data.user) await authorize(data.user);
  } catch (e) {
    lock();
    message(errorText(e));
  }
})();
const botonBuscar = document.getElementById("searchBtn");

botonBuscar.disabled = false;
botonBuscar.textContent = "Buscar coincidencias · Prueba";

botonBuscar.onclick = async () => {
  if (!db || !profile) {
    message("Primero iniciá sesión.");
    return;
  }

  if (!photoBlob) {
    message("Primero tomá o subí una fotografía.");
    return;
  }

  const usuarioConsulta = profile.id;
  const controlador = new AbortController();
  const tiempo = setTimeout(() => controlador.abort(), 60000);

  botonBuscar.disabled = true;
  botonBuscar.textContent = "Buscando…";

  try {
    const { data, error } = await db.auth.getSession();

    if (error || !data.session) {
      throw new Error("La sesión venció. Volvé a ingresar.");
    }

    const formulario = new FormData();
    formulario.append("foto", photoBlob, "consulta.jpg");

    const respuesta = await fetch("http://127.0.0.1:8000/buscar", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
      },
      body: formulario,
      signal: controlador.signal,
    });

    const resultado = await respuesta.json();

    if (!respuesta.ok) {
      throw new Error(
        typeof resultado.detail === "string"
          ? resultado.detail
          : "No se pudo realizar la búsqueda.",
      );
    }

    // Evitar mostrar datos si se cerró o cambió la sesión.
    if (profile?.id !== usuarioConsulta) return;

    const contenedor = document.getElementById("result");
    contenedor.replaceChildren();

    const aviso = document.createElement("p");
    aviso.textContent =
      "Candidatos de prueba, sin umbral. " +
      "La similitud no confirma la identidad.";
    contenedor.append(aviso);

    const candidatos = resultado.candidatos || [];

    if (!candidatos.length) {
      const texto = document.createElement("p");
      texto.textContent =
        "No hay candidatos disponibles. " +
        "Comprobá que las fotografías tengan descriptores.";
      contenedor.append(texto);
    }

    candidatos.forEach((persona) => {
      const tarjeta = document.createElement("div");
      tarjeta.className = "result";

      const nombre = document.createElement("strong");
      nombre.textContent = persona.nombre;

      const puntuacion = document.createElement("p");
      puntuacion.textContent =
        "Similitud: " + Number(persona.similitud).toFixed(4);

      tarjeta.append(nombre, puntuacion);
      contenedor.append(tarjeta);
    });
  } catch (error) {
    if (profile?.id !== usuarioConsulta) return;

    message(
      error.name === "AbortError"
        ? "La búsqueda superó el tiempo de espera."
        : error.message,
    );
  } finally {
    clearTimeout(tiempo);
    botonBuscar.disabled = false;
    botonBuscar.textContent = "Buscar coincidencias · Prueba";
  }
};
