/**
 * Proveedor de Nuvio: MiPlugin (v2)
 *
 * Flujo:
 *   1. TMDB: ID → título en español, título original y año
 *   2. Post: URL directa armada con el slug del título; si no existe, búsqueda por título
 *   3. Servidores: embeds del post (fastream y otros) o un .m3u8 que ya venga en el post
 *   4. Video: desempaqueta el JS ofuscado del embed y saca el .m3u8 firmado
 *
 * Solo cadenas de promesas (.then / .catch), sin async/await, sintaxis ES5 (var / function)
 * para máxima compatibilidad con Hermes.
 */

/* ============================================================
 * CONFIGURACIÓN (lo único que normalmente tienes que tocar)
 * ============================================================ */

var PROVIDER_NAME = "MiPlugin";

// Dominio del sitio, sin barra al final
var BASE_URL = "https://cinehaxplus.com";

// Rutas del sitio. {slug}, {season}, {episode} y {query} se reemplazan solos.
var MOVIE_PATH = "/pelicula/{slug}";
var EPISODE_PATH = "/serie/{slug}/temporada/{season}/episodio/{episode}";
var MOVIE_PREFIX = "/pelicula/";
var SERIES_PREFIX = "/serie/";
var SEARCH_PATH = "/?s={query}";

// Opcional pero recomendado: tu API key (v3) de TMDB.
// Si la dejas vacía, el plugin lee el título desde la página web de TMDB.
var TMDB_API_KEY = "";
var TMDB_LANGUAGE = "es-MX";

var USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Máximo de servidores que se revisan por título (cada uno es una petición extra)
var MAX_SERVERS = 4;

// Dominios que nunca son el video (tráileres, redes sociales, comentarios)
var IGNORED_HOSTS = /(?:youtube\.com|youtu\.be|google|facebook|twitter|x\.com|instagram|tiktok|disqus|gstatic|cloudflare)/i;

/* ============================================================
 * Utilidades generales
 * ============================================================ */

var HOST = BASE_URL.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Acepta enlaces absolutos (con o sin www) o relativos (/...)
var DOMAIN_PATTERN = "(?:https?:\\/\\/(?:www\\.)?" + escapeRegex(HOST) + ")?";

function fillTemplate(tpl, values) {
  return tpl.replace(/\{(\w+)\}/g, function (whole, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole;
  });
}

function uniqueNonEmpty(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] ? String(list[i]).trim() : "";
    if (item && !seen[item.toLowerCase()]) {
      seen[item.toLowerCase()] = true;
      out.push(item);
    }
  }
  return out;
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Quita las barras escapadas de JSON (https:\/\/...) y entidades HTML
function cleanText(html) {
  return String(html)
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

var ACCENTS = {
  "á": "a", "à": "a", "ä": "a", "â": "a", "ã": "a",
  "é": "e", "è": "e", "ë": "e", "ê": "e",
  "í": "i", "ì": "i", "ï": "i", "î": "i",
  "ó": "o", "ò": "o", "ö": "o", "ô": "o", "õ": "o",
  "ú": "u", "ù": "u", "ü": "u", "û": "u",
  "ñ": "n", "ç": "c"
};

// "El Club de la Pelea: Edición" → "el-club-de-la-pelea-edicion"
// (sin String.normalize porque Hermes no siempre lo trae)
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[áàäâãéèëêíìïîóòöôõúùüûñç]/g, function (ch) { return ACCENTS[ch] || ch; })
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toAbsolute(url, base) {
  if (!url) return null;
  url = String(url).trim().replace(/&amp;/g, "&");

  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf("//") === 0) return "https:" + url;

  var origin = originOf(base) || BASE_URL;
  if (url.charAt(0) === "/") return origin + url;

  var basePath = String(base).split(/[?#]/)[0];
  return basePath.substring(0, basePath.lastIndexOf("/") + 1) + url;
}

function originOf(url) {
  var m = String(url || "").match(/^(https?:\/\/[^\/?#]+)/i);
  return m ? m[1] : null;
}

function hostOf(url) {
  var m = String(url || "").match(/^https?:\/\/(?:www\.)?([^\/?#:]+)/i);
  return m ? m[1] : "";
}

/* ============================================================
 * Red
 * ============================================================ */

function fetchText(url, referer) {
  var headers = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9,en;q=0.8"
  };
  if (referer) headers["Referer"] = referer;

  return fetch(url, { method: "GET", headers: headers }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " en " + url);
    return res.text();
  });
}

/**
 * Prueba fn(item) con cada elemento, en orden, y se queda con el primer
 * resultado que no sea null. Los errores de un intento no cortan la cadena.
 */
function tryInOrder(items, fn) {
  return items.reduce(function (chain, item) {
    return chain.then(function (found) {
      if (found) return found;
      return Promise.resolve()
        .then(function () { return fn(item); })
        .catch(function () { return null; });
    });
  }, Promise.resolve(null));
}

/* ============================================================
 * Paso 1: título desde TMDB
 * ============================================================ */

function getTmdbInfo(tmdbId, type) {
  var kind = type === "tv" ? "tv" : "movie";

  if (TMDB_API_KEY) {
    var apiUrl = "https://api.themoviedb.org/3/" + kind + "/" + encodeURIComponent(tmdbId) +
      "?api_key=" + encodeURIComponent(TMDB_API_KEY) +
      "&language=" + TMDB_LANGUAGE + "&append_to_response=translations";

    return fetch(apiUrl, { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("TMDB API HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var titles = [data.title || data.name];
        var translations = (data.translations && data.translations.translations) || [];
        for (var i = 0; i < translations.length; i++) {
          var tr = translations[i];
          if (tr.iso_639_1 === "es" && tr.data) titles.push(tr.data.title || tr.data.name);
        }
        titles.push(data.original_title || data.original_name);
        var date = data.release_date || data.first_air_date || "";
        return { titles: uniqueNonEmpty(titles), year: date.slice(0, 4) };
      });
  }

  // Sin API key: se lee la página pública de TMDB
  var pageUrl = "https://www.themoviedb.org/" + kind + "/" + encodeURIComponent(tmdbId) +
    "?language=" + TMDB_LANGUAGE;

  return fetchText(pageUrl).then(function (html) {
    var titles = [];
    var og =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (og) titles.push(cleanTmdbTitle(og[1]));

    var titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleTag) titles.push(cleanTmdbTitle(titleTag[1]));

    var yearSource = (titleTag ? titleTag[1] : "") + " " + (og ? og[1] : "");
    var year = yearSource.match(/\([^)]*?((?:19|20)\d{2})/);

    return { titles: uniqueNonEmpty(titles), year: year ? year[1] : "" };
  });
}

// Quita el año y el sufijo " ... The Movie Database (TMDB)" del título de la página
function cleanTmdbTitle(raw) {
  return decodeEntities(raw)
    .replace(/\s*(?:\u2014|\u2013|-|\|)\s*The Movie Database.*$/i, "")
    .replace(/\s*\([^)]*\d{4}[^)]*\)\s*$/, "")
    .trim();
}

/* ============================================================
 * Paso 2: encontrar el post
 * ============================================================ */

function buildPostUrl(slug, type, season, episode) {
  var path = type === "tv"
    ? fillTemplate(EPISODE_PATH, { slug: slug, season: season, episode: episode })
    : fillTemplate(MOVIE_PATH, { slug: slug });
  return BASE_URL + path;
}

// URLs directas a probar: slug de cada título, con y sin el año
function candidatePostUrls(info, type, season, episode) {
  var urls = [];
  for (var i = 0; i < info.titles.length; i++) {
    var slug = slugify(info.titles[i]);
    if (!slug) continue;
    urls.push(buildPostUrl(slug, type, season, episode));
    if (info.year) urls.push(buildPostUrl(slug + "-" + info.year, type, season, episode));
  }
  return uniqueNonEmpty(urls);
}

// Descarga un post y solo lo acepta si de verdad trae servidores de video
function loadPost(url, referer) {
  return fetchText(url, referer).then(function (html) {
    var servers = findServers(html, url);
    return servers.length ? { url: url, servers: servers } : null;
  });
}

// Qué tan parecido es un slug del sitio al slug del título (0 a 1)
function slugScore(siteSlug, titleSlug, year) {
  if (siteSlug === titleSlug || siteSlug === titleSlug + "-" + year) return 1;
  var a = siteSlug.split("-");
  var b = titleSlug.split("-");
  var inB = {};
  var union = {};
  var shared = 0;
  var total = 0;
  var i;
  for (i = 0; i < b.length; i++) { inB[b[i]] = true; union[b[i]] = true; }
  for (i = 0; i < a.length; i++) {
    if (a[i] === year) continue;
    if (inB[a[i]]) shared++;
    union[a[i]] = true;
  }
  for (var k in union) if (Object.prototype.hasOwnProperty.call(union, k)) total++;
  return total ? shared / total : 0;
}

function pickBestSlug(html, type, info) {
  var prefix = type === "tv" ? SERIES_PREFIX : MOVIE_PREFIX;
  var re = new RegExp("[\"']" + DOMAIN_PATTERN + escapeRegex(prefix) + "([a-z0-9][a-z0-9\\-]*)", "gi");
  var targets = [];
  for (var i = 0; i < info.titles.length; i++) targets.push(slugify(info.titles[i]));

  var text = cleanText(html);
  var best = null;
  var bestScore = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    var slug = m[1].toLowerCase();
    for (var j = 0; j < targets.length; j++) {
      var score = slugScore(slug, targets[j], info.year);
      if (score > bestScore) {
        bestScore = score;
        best = slug;
      }
    }
  }
  return bestScore >= 0.6 ? best : null;
}

function searchPost(info, type, season, episode) {
  return tryInOrder(info.titles, function (title) {
    var searchUrl = BASE_URL + fillTemplate(SEARCH_PATH, { query: encodeURIComponent(title) });
    return fetchText(searchUrl, BASE_URL + "/").then(function (html) {
      var slug = pickBestSlug(html, type, info);
      if (!slug) return null;
      return loadPost(buildPostUrl(slug, type, season, episode), searchUrl);
    });
  });
}

/* ============================================================
 * Paso 3: servidores dentro del post
 * ============================================================ */

function findServers(html, pageUrl) {
  var text = cleanText(html);
  var servers = [];
  var seen = {};

  function add(type, url) {
    url = toAbsolute(decodeEntities(url), pageUrl);
    if (!url || seen[url]) return;
    if (type === "embed" && IGNORED_HOSTS.test(hostOf(url))) return;
    seen[url] = true;
    servers.push({ type: type, url: url });
  }

  // a) El post ya trae el .m3u8 (el sitio lo resuelve por su cuenta)
  var direct = findVideoUrls(text, pageUrl, false);
  for (var d = 0; d < direct.length; d++) add("direct", direct[d]);

  // b) Enlaces de fastream en cualquier parte del HTML o del JSON
  var fastream = text.match(/https?:\/\/(?:[a-z0-9-]+\.)*fastream\.to\/[^"'\s<>\\)]+/gi) || [];
  for (var f = 0; f < fastream.length; f++) {
    if (!/\.(?:m3u8|ts|jpg|png|vtt)(?:\?|$)/i.test(fastream[f])) add("embed", fastream[f]);
  }

  // c) Etiquetas <iframe> (src o data-src)
  var tags = text.match(/<iframe\b[^>]*>/gi) || [];
  for (var t = 0; t < tags.length; t++) {
    var src = tags[t].match(/\sdata-src=["']([^"']+)["']/i) || tags[t].match(/\ssrc=["']([^"']+)["']/i);
    if (src && !/^(?:about:|javascript:)/i.test(src[1])) add("embed", src[1]);
  }

  // d) Cualquier otro enlace con forma de reproductor (/embed/, /e/, embed-xxx.html)
  var generic = text.match(/https?:\/\/[^"'\s<>\\)]+?\/(?:embed-[a-z0-9]+\.html|embed\/[^"'\s<>\\)]+|e\/[a-z0-9]+)/gi) || [];
  for (var g = 0; g < generic.length; g++) add("embed", generic[g]);

  // Directos primero, después fastream, después el resto
  servers.sort(function (x, y) { return rank(x) - rank(y); });
  return servers.slice(0, MAX_SERVERS);
}

function rank(server) {
  if (server.type === "direct") return 0;
  return /fastream\.to/i.test(server.url) ? 1 : 2;
}

/* ============================================================
 * Paso 4: sacar el video del embed
 * ============================================================ */

/**
 * Desempaqueta todos los bloques eval(function(p,a,c,k,e,d){...}) del HTML.
 * Es el ofuscador "packer" que usan fastream y otros servidores parecidos.
 */
function unpackAll(html) {
  var re = /eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  var out = [];
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(unpack(m[1], parseInt(m[2], 10), m[4].split("|")));
    } catch (e) {
      // un bloque roto no debe tumbar los demás
    }
  }
  return out.join("\n");
}

var PACK_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function unpack(payload, base, keywords) {
  var p = payload.replace(/\\(['"\\])/g, "$1");
  return p.replace(/\b\w+\b/g, function (word) {
    var n = decodeBase(word, base);
    return n >= 0 && n < keywords.length && keywords[n] ? keywords[n] : word;
  });
}

function decodeBase(word, base) {
  var n = 0;
  for (var i = 0; i < word.length; i++) {
    var idx = PACK_CHARS.indexOf(word.charAt(i));
    if (idx < 0 || idx >= base) return -1;
    n = n * base + idx;
  }
  return n;
}

/**
 * Todas las URLs .m3u8 (primero) y .mp4 del texto.
 * allowRelative: también acepta rutas como "/stream/x/master.m3u8".
 */
function findVideoUrls(text, baseUrl, allowRelative) {
  var clean = cleanText(text);
  var found = [];
  var seen = {};
  var exts = ["m3u8", "mp4"];

  for (var e = 0; e < exts.length; e++) {
    var abs = new RegExp("https?:\\/\\/[^\"'\\s<>\\\\]+?\\." + exts[e] + "(?:\\?[^\"'\\s<>\\\\]*)?", "gi");
    var list = clean.match(abs) || [];

    if (allowRelative) {
      var rel = new RegExp("[\"']([^\"'\\s<>:]+?\\." + exts[e] + "(?:\\?[^\"'\\s<>]*)?)[\"']", "gi");
      var m;
      while ((m = rel.exec(clean)) !== null) list.push(m[1]);
    }

    for (var i = 0; i < list.length; i++) {
      var url = toAbsolute(list[i], baseUrl);
      if (url && !seen[url]) {
        seen[url] = true;
        found.push(url);
      }
    }
  }
  return found;
}

function detectQuality(url) {
  if (/(?:^|[^a-z0-9])4k(?:[^a-z0-9]|$)/i.test(url)) return "2160p";
  var match = url.match(/(?:^|[^0-9])(2160|1440|1080|720|480|360)p?(?![0-9])/i);
  if (match) return match[1] + "p";
  // Un master.m3u8 trae varias calidades y el reproductor elige
  return /master\.m3u8/i.test(url) ? "Auto" : "1080p";
}

// Visita cada servidor y devuelve los streams que sí tengan video
function resolveServers(post) {
  var tasks = post.servers.map(function (server) {
    if (server.type === "direct") {
      return Promise.resolve({ url: server.url, referer: post.url, origin: originOf(post.url) });
    }

    // El servidor exige la URL del post como Referer para entregar el embed
    return fetchText(server.url, post.url)
      .then(function (html) {
        var urls = findVideoUrls(html + "\n" + unpackAll(html), server.url, true);
        if (!urls.length) return null;
        // El navegador manda solo el origen del embed como Referer al pedir el .m3u8
        var origin = originOf(server.url);
        return { url: urls[0], referer: origin + "/", origin: origin };
      })
      .catch(function () { return null; });
  });

  return Promise.all(tasks).then(function (results) {
    var streams = [];
    var seen = {};
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || seen[r.url]) continue;
      seen[r.url] = true;
      streams.push({
        name: PROVIDER_NAME,
        title: "Servidor " + (streams.length + 1) + " (" + hostOf(r.url) + ")",
        url: r.url,
        quality: detectQuality(r.url),
        headers: {
          "Referer": r.referer,
          "Origin": r.origin,
          "User-Agent": USER_AGENT
        }
      });
    }
    return streams;
  });
}

/* ============================================================
 * Función exportada
 * ============================================================ */

function getStreams(tmdbId, mediaType, season, episode) {
  var type = (mediaType === "tv" || mediaType === "series" || mediaType === "show") ? "tv" : "movie";
  var s = parseInt(season, 10);
  var e = parseInt(episode, 10);
  var info = null;

  // Promise.resolve() inicial: cualquier error síncrono también termina en el .catch()
  return Promise.resolve()
    .then(function () {
      if (!tmdbId) throw new Error("tmdbId vacío");
      if (type === "tv" && (isNaN(s) || isNaN(e))) {
        throw new Error("Faltan temporada o episodio para una serie");
      }
      return getTmdbInfo(tmdbId, type);
    })
    .then(function (data) {
      info = data;
      if (!info.titles.length) throw new Error("TMDB no devolvió título para " + tmdbId);
      // Intento rápido: la URL armada con el slug del título
      return tryInOrder(candidatePostUrls(info, type, s, e), function (url) {
        return loadPost(url, BASE_URL + "/");
      });
    })
    .then(function (post) {
      // Si la URL directa no existe, se busca por título
      return post || searchPost(info, type, s, e);
    })
    .then(function (post) {
      if (!post) throw new Error("No se encontró el post de: " + info.titles.join(" / "));
      return resolveServers(post);
    })
    .then(function (streams) {
      if (!streams.length) throw new Error("Ningún servidor devolvió un .m3u8/.mp4");
      return streams;
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
