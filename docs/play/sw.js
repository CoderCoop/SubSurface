/*
 * Subsurface — service worker.
 *
 * The whole game is a handful of static files with no network calls at
 * runtime, so the app shell IS the app: precache it once and every later load
 * is offline-capable and instant.
 *
 * Bump CACHE_VERSION whenever any precached file changes. Without that bump a
 * returning player keeps the old build forever, because the cache-first
 * strategy below never goes to the network for a file it already holds.
 */
'use strict';

var CACHE_VERSION = 'subsurface-v1';

// Relative paths throughout: the app is served from a subdirectory on GitHub
// Pages (/SubSurface/play/), so anything root-absolute would resolve wrong.
var SHELL = [
  './',
  './index.html',
  './app.js',
  './sim.js',
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
        return cache.addAll(SHELL);
      })
      // Take over as soon as the new build is cached rather than waiting for
      // every tab to close.
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

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;

  // A navigation that misses the cache (deep link, hard refresh offline) still
  // has to land somewhere, so fall back to the cached shell.
  if (req.mode === 'navigate') {
    ev.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  ev.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Only worth caching same-origin successes; opaque cross-origin
        // responses would fill the cache with things we cannot validate.
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (cache) {
          cache.put(req, copy);
        });
        return res;
      });
    })
  );
});
