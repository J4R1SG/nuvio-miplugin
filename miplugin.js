/**
 * Proveedor de Nuvio: MiPlugin
 *
 * Flujo: búsqueda por TMDB ID → post (película/episodio) → iframe → .m3u8 / .mp4
 *
 * Escrito solo con cadenas de promesas (.then / .catch), sin async/await,
 * y con sintaxis ES5 (var / function) para máxima compatibilidad con Hermes.
 */

var PROVIDER_NAME = "MiPlugin";
var BASE_URL = "https://cinehaxplus.com/";
var USER_AGENT = "Mozilla/5.0";

// Dominio del sitio sin protocolo ni "www." (para armar las regex de enlaces)
var HOST = BASE_URL.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");

/* ============================================================
 * Utilidades
 * ============================================================ */

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Acepta enlaces absolutos (https://ejemplo.com/..., con o sin www) o relativos (/...)
var DOMAIN_PATTERN = "(?:https?:\\/\\/(?:www\\.)?" + escapeRegex(HOST) + ")?";

/**
 * Convierte una URL relativa o protocol-relative en absoluta.
 * No usa la clase URL porque Hermes no siempre la trae completa.
 */
function toAbsolute(url, base) {
  if (!url) return null;
  url = String(url).trim().replace(/&amp;/g, "&");

  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf("//") === 0) return "https:" + url;

  var originMatch = String(base).match(/^(https?:\/\/[^\/?#]+)/i);
  var origin = originMatch ? originMatch[1] : BASE_URL;

  if (url.charAt(0) === "/") return origin + url;

  // Ruta relativa al directorio de la página base
  var basePath = String(base).split(/[?#]/)[0];
  return basePath.substring(0, basePath.lastIndexOf("/") + 1) + url;
}

/**
 * GET que devuelve el HTML como texto. Si el status no es 2xx lanza un error,
 * lo que salta directamente al .catch() final de getStreams.
 */
function fetchText(url, referer) {
  var headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = referer;

  return fetch(url, { method: "GET", headers: headers }).then(function (res) {
    if (!res.ok) {
      throw new Error("HTTP " + res.status + " en " + url);
    }
    return res.text();
  });
}

/* ============================================================
 * Paso 2: encontrar el post en el HTML de la búsqueda
 * ============================================================ */

function findPostUrl(html, type, season, episode) {
  var match;

  if (type === "movie") {
    // href="https://ejemplo.com/pelicula/titulo"  o  href="/pelicula/titulo/"
    match = html.match(new RegExp(
      'href=["\'](' + DOMAIN_PATTERN + '\\/pelicula\\/[^"\'#?\\s]+)["\']',
      "i"
    ));
    return match ? toAbsolute(match[1], BASE_URL) : null;
  }

  // Serie, intento 1: enlace directo al episodio exacto.
  // El \/?["'] del final evita que "episodio-1" coincida con "episodio-10".
  match = html.match(new RegExp(
    'href=["\'](' + DOMAIN_PATTERN +
      '\\/serie\\/[^"\'\\/#?\\s]+\\/temporada-' + season +
      '\\/episodio-' + episode + ')\\/?["\']',
    "i"
  ));
  if (match) return toAbsolute(match[1], BASE_URL);

  // Serie, intento 2: la búsqueda solo devuelve la ficha de la serie,
  // así que se construye la ruta del episodio a mano.
  match = html.match(new RegExp(
    'href=["\'](' + DOMAIN_PATTERN + '\\/serie\\/[^"\'\\/#?\\s]+)\\/?["\']',
    "i"
  ));
  if (match) {
    return toAbsolute(match[1], BASE_URL) + "/temporada-" + season + "/episodio-" + episode;
  }

  return null;
}

/* ============================================================
 * Paso 3: encontrar el iframe del reproductor en el post
 * ============================================================ */

function findIframeUrl(html, pageUrl) {
  // Con la bandera g, match() devuelve todas las etiquetas <iframe ...>
  var tags = html.match(/<iframe\b[^>]*>/gi);
  if (!tags) return null;

  for (var i = 0; i < tags.length; i++) {
    // Prioriza data-src (lazy load) y luego src
    var srcMatch =
      tags[i].match(/\sdata-src=["']([^"']+)["']/i) ||
      tags[i].match(/\ssrc=["']([^"']+)["']/i);
    if (!srcMatch) continue;

    var src = srcMatch[1].trim();
    if (!src || /^about:blank/i.test(src) || /^javascript:/i.test(src)) continue;

    return toAbsolute(src, pageUrl);
  }
  return null;
}

/* ============================================================
 * Paso 4: encontrar el .m3u8 / .mp4 en el HTML del iframe
 * ============================================================ */

function findVideoUrl(html, iframeUrl) {
  // Muchos reproductores guardan la URL en JSON con barras escapadas: https:\/\/...
  var clean = html.replace(/\\\//g, "/").replace(/&amp;/g, "&");

  // Orden de preferencia: m3u8 absoluto, m3u8 relativo, mp4 absoluto, mp4 relativo
  var patterns = [
    /(https?:\/\/[^"'\s<>\\]+?\.m3u8(?:\?[^"'\s<>\\]*)?)/i,
    /["']([^"'\s<>:]+?\.m3u8(?:\?[^"'\s<>]*)?)["']/i,
    /(https?:\/\/[^"'\s<>\\]+?\.mp4(?:\?[^"'\s<>\\]*)?)/i,
    /["']([^"'\s<>:]+?\.mp4(?:\?[^"'\s<>]*)?)["']/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = clean.match(patterns[i]);
    if (match) return toAbsolute(match[1], iframeUrl);
  }
  return null;
}

/**
 * Intenta leer la calidad desde la URL (…/1080p/…, _720.m3u8, etc.).
 * Si no aparece, usa "1080p" como valor por defecto.
 */
function detectQuality(url) {
  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)/i.test(url)) return "2160p";
  var match = url.match(/(?:^|[^0-9])(2160|1440|1080|720|480|360)p?(?![0-9])/i);
  return match ? match[1] + "p" : "1080p";
}

/* ============================================================
 * Función exportada
 * ============================================================ */

function getStreams(tmdbId, mediaType, season, episode) {
  var type = (mediaType === "tv" || mediaType === "series" || mediaType === "show") ? "tv" : "movie";
  var s = parseInt(season, 10);
  var e = parseInt(episode, 10);

  var searchUrl = BASE_URL + "/?s=" + encodeURIComponent(tmdbId);
  var postUrl = null;
  var iframeUrl = null;

  // Promise.resolve() inicial: cualquier error síncrono también termina en el .catch()
  return Promise.resolve()
    .then(function () {
      if (!tmdbId) throw new Error("tmdbId vacío");
      if (type === "tv" && (isNaN(s) || isNaN(e))) {
        throw new Error("Faltan temporada o episodio para una serie");
      }
      // Paso 1: búsqueda por TMDB ID
      return fetchText(searchUrl, BASE_URL + "/");
    })
    .then(function (searchHtml) {
      // Paso 2: enlace al post
      postUrl = findPostUrl(searchHtml, type, s, e);
      if (!postUrl) throw new Error("No se encontró el post en la búsqueda");
      return fetchText(postUrl, searchUrl);
    })
    .then(function (postHtml) {
      // Paso 3: iframe del reproductor
      iframeUrl = findIframeUrl(postHtml, postUrl);
      if (!iframeUrl) throw new Error("No se encontró el iframe en " + postUrl);
      // El servidor del iframe exige la URL del post como Referer
      return fetchText(iframeUrl, postUrl);
    })
    .then(function (iframeHtml) {
      // Paso 4: archivo de video
      var videoUrl = findVideoUrl(iframeHtml, iframeUrl);
      if (!videoUrl) throw new Error("No se encontró .m3u8/.mp4 en " + iframeUrl);

      return [{
        name: PROVIDER_NAME,
        title: "Auto",
        url: videoUrl,
        quality: detectQuality(videoUrl),
        headers: {
          "Referer": iframeUrl,
          "User-Agent": USER_AGENT
        }
      }];
    })
    .catch(function (err) {
      console.log("[" + PROVIDER_NAME + "] " + (err && err.message ? err.message : String(err)));
      return [];
    });
}

// Exportación compatible con el cargador de plugins
if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams: getStreams };
} else if (typeof global !== "undefined") {
  global.getStreams = getStreams;
}
