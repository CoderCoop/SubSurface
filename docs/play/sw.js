/*
 * Subsurface — service worker.
 *
 * The whole game is a handful of static files with no network calls at
 * runtime, so the app shell IS the app: precache it once and every later load
 * is offline-capable and instant.
 *
 * ---------------------------------------------------------------------------
 * Why the strategy is split rather than cache-first everywhere
 *
 * It used to be cache-first for everything, with a comment saying "bump
 * CACHE_VERSION whenever any precached file changes". That is a rule a human
 * has to remember, and the first time it mattered it was forgotten: app.js
 * shipped a new build while the version stayed put. Navigations were already
 * network-first, so browsers fetched the NEW index.html and paired it with the
 * OLD cached app.js. The markup had a Start button the stale code knew nothing
 * about, so the game loaded and the button did nothing.
 *
 * Mixed-generation assets are the failure mode to design out, so code is now
 * network-first: the newest build always wins when online, and the cache is
 * the offline fallback rather than the source of truth. Only genuinely static
 * assets — the physics bundle and the icons — stay cache-first, since they are
 * large and change rarely.
 * ---------------------------------------------------------------------------
 */
'use strict';

var CACHE_VERSION = 'subsurface-v2';

// Relative paths throughout: the app is served from a subdirectory on GitHub
// Pages (/SubSurface/play/), so anything root-absolute would resolve wrong.
var SHELL = [
  './',
  './index.html',
  './app.js',
  './sim.js',
  './levels.js',
  './bodies.js',
  './vendor/planck.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then(function (cache) {
        // Bypass the HTTP cache when filling ours, or a stale intermediary
        // response can be baked in at install time.
        return cache.addAll(
          SHELL.map(function (u) {
            return new Request(u, { cache: 'reload' });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return k === CACHE_VERSION ? null : caches.delete(k);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// Code has to be able to change; large static assets do not.
function isCode(url) {
  if (url.pathname.indexOf('/vendor/') !== -1) return false;
  return (
    /\.(?:js|html|webmanifest)$/.test(url.pathname) || url.pathname.endsWith('/')
  );
}

function networkFirst(req) {
  return fetch(req)
    .then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) {
          cache.put(req, copy);
        });
      }
      return res;
    })
    .catch(function () {
      return caches.match(req).then(function (hit) {
        // A navigation that misses entirely still has to land somewhere.
        return hit || caches.match('./index.html');
      });
    });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (!res || res.status !== 200 || res.type !== 'basic') return res;
      var copy = res.clone();
      caches.open(CACHE_VERSION).then(function (cache) {
        cache.put(req, copy);
      });
      return res;
    });
  });
}

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;

  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    req.mode === 'navigate' || isCode(url) ? networkFirst(req) : cacheFirst(req)
  );
});
