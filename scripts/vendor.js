#!/usr/bin/env node
/*
 * Copies the physics engine out of node_modules and into the shipped game.
 *
 * The game is served as plain static files from docs/, so it cannot reach into
 * node_modules at runtime — the dependency has to be committed alongside it.
 * Run this after changing the planck version; test/vendor.test.js fails if the
 * committed copy and the installed one ever drift apart.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const from = path.join(root, 'node_modules', 'planck', 'dist', 'planck.min.js');
const to = path.join(root, 'docs', 'play', 'vendor', 'planck.min.js');

if (!fs.existsSync(from)) {
  console.error('planck not installed — run `npm install` first.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(to), { recursive: true });
fs.copyFileSync(from, to);

const version = require(path.join(root, 'node_modules', 'planck', 'package.json')).version;
console.log(`vendored planck ${version} -> ${path.relative(root, to)}`);
