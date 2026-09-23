/* Service worker de Eurotrip 2026.
   Dos cachés separadas a propósito:
   - "cascara": el HTML, el manifest y los íconos. Se renueva sola al publicar.
   - "audio": los MP3. Nunca se tocan solos; los baja y los borra el usuario. */

const VERSION = "cb1ceab4cc";
const CACHE_CASCARA = "eurotrip-cascara-" + VERSION;
const CACHE_AUDIO = "eurotrip-audio-v1";

const CASCARA = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE_CASCARA)
      .then(function (c) { return c.addAll(CASCARA); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(nombres.map(function (n) {
        // Borra cáscaras viejas. La caché de audio sobrevive a las publicaciones.
        if (n.indexOf("eurotrip-cascara-") === 0 && n !== CACHE_CASCARA) {
          return caches.delete(n);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Audio: primero la caché, siempre. Si no está, no hay red que valga.
  if (url.pathname.indexOf("/audio/") !== -1 && url.pathname.slice(-4) === ".mp3") {
    ev.respondWith(
      caches.open(CACHE_AUDIO).then(function (c) {
        /* Tres intentos, del más estricto al más tolerante. El navegador pide
           los MP3 con cabeceras propias del reproductor (Range, Accept-Encoding),
           y si la respuesta guardada trae "Vary" el match exacto puede fallar
           aunque el archivo esté. ignoreVary saca ese factor del medio.
           El tercero ignora la huella: solo puede encontrar algo si el barrido
           de "limpiar" no lo borró, o sea si sigue vigente. */
        const opts = { ignoreVary: true };
        return c.match(req, opts)
          .then(function (h) { return h || c.match(url.pathname + url.search, opts); })
          .then(function (h) { return h || c.match(req, { ignoreVary: true, ignoreSearch: true }); })
          .then(function (hit) {
            if (hit) return hit;
            return fetch(req).catch(function () {
              return new Response("", { status: 504, statusText: "sin audio guardado" });
            });
          });
      })
    );
    return;
  }

  // Cáscara: red primero para que se actualice sola, caché si no hay señal.
  ev.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        const copia = res.clone();
        caches.open(CACHE_CASCARA).then(function (c) { c.put(req, copia); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});

/* La app pide descargar o borrar el audio de una ciudad por mensajes. */
self.addEventListener("message", function (ev) {
  const msg = ev.data || {};
  const responder = function (payload) {
    if (ev.ports && ev.ports[0]) ev.ports[0].postMessage(payload);
  };

  if (msg.tipo === "estado") {
    caches.open(CACHE_AUDIO).then(function (c) {
      return Promise.all(msg.urls.map(function (u) {
        return c.match(u).then(function (hit) { return hit ? 1 : 0; });
      }));
    }).then(function (hits) {
      responder({ guardadas: hits.reduce(function (a, b) { return a + b; }, 0) });
    }).catch(function () { responder({ guardadas: 0 }); });
    return;
  }

  if (msg.tipo === "descargar") {
    caches.open(CACHE_AUDIO).then(function (c) {
      let hechas = 0, fallidas = 0;
      const siguiente = function (i) {
        if (i >= msg.urls.length) {
          responder({ listo: true, hechas: hechas, fallidas: fallidas });
          return;
        }
        const u = msg.urls[i];
        c.match(u).then(function (hit) {
          if (hit) { hechas++; avisar(i + 1); return siguiente(i + 1); }
          return fetch(u, { cache: "no-store" }).then(function (res) {
            if (!res || !res.ok) throw new Error("http " + (res && res.status));
            /* Se reenvuelve el cuerpo en una respuesta nueva y mínima. Así lo
               que queda guardado no arrastra "Vary" ni nada del servidor, y el
               reproductor lo encuentra siempre. */
            return res.blob().then(function (b) {
              return c.put(u, new Response(b, {
                status: 200,
                headers: { "Content-Type": "audio/mpeg", "Content-Length": String(b.size) }
              }));
            });
          }).then(function () {
            hechas++; avisar(i + 1); siguiente(i + 1);
          }).catch(function () {
            fallidas++; avisar(i + 1); siguiente(i + 1);
          });
        });
      };
      const avisar = function (n) {
        self.clients.matchAll().then(function (cs) {
          cs.forEach(function (cl) {
            cl.postMessage({ tipo: "progreso", ciudad: msg.ciudad, hechas: n, total: msg.urls.length });
          });
        });
      };
      siguiente(0);
    });
    return;
  }

  /* Barrido: saca de la caché de audio todo lo que ya no está en la app.
     Pasa cuando reescribo un guion (cambia la huella de la URL) o cuando
     saco una parada. Así el teléfono no acumula MP3 huérfanos. */
  if (msg.tipo === "limpiar") {
    caches.open(CACHE_AUDIO).then(function (c) {
      return c.keys().then(function (claves) {
        const vigentes = {};
        msg.urls.forEach(function (u) { vigentes[u] = 1; });
        const sobran = claves.filter(function (req) { return !vigentes[req.url]; });
        return Promise.all(sobran.map(function (req) { return c.delete(req); }))
          .then(function () { return sobran.length; });
      });
    }).then(function (n) { responder({ borradas: n }); })
      .catch(function () { responder({ borradas: 0 }); });
    return;
  }

  /* Diagnóstico: dice si cada URL que la app espera está realmente guardada. */
  if (msg.tipo === "probar") {
    caches.open(CACHE_AUDIO).then(function (c) {
      return c.keys().then(function (claves) {
        return Promise.all(msg.urls.map(function (u) {
          return c.match(u, { ignoreVary: true }).then(function (h) {
            return { url: u, ok: !!h, tipo: h ? (h.headers.get("content-type") || "?") : null,
                     bytes: h ? (h.headers.get("content-length") || "?") : null };
          });
        })).then(function (r) {
          return { guardadas: claves.length, ejemplo: claves.length ? claves[0].url : null, pruebas: r };
        });
      });
    }).then(responder).catch(function (e) { responder({ error: String(e) }); });
    return;
  }

  if (msg.tipo === "borrar") {
    caches.open(CACHE_AUDIO).then(function (c) {
      return Promise.all(msg.urls.map(function (u) { return c.delete(u); }));
    }).then(function () { responder({ listo: true }); });
  }
});
