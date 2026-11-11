import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve('.');

test('Seam 4: firebase.json exists and cleanly configures static hosting SPA rewrites', () => {
  const firebaseJsonPath = path.join(REPO_ROOT, 'firebase.json');
  assert.ok(fs.existsSync(firebaseJsonPath), 'firebase.json must exist');

  const content = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
  assert.ok(content.hosting, 'firebase.json must contain hosting block');
  assert.ok(content.hosting.public, 'hosting block must define public directory');
  assert.ok(Array.isArray(content.hosting.rewrites), 'hosting block must define rewrites');

  const spaRewrite = content.hosting.rewrites.find(r => r.source === '**' && r.destination === '/index.html');
  assert.ok(spaRewrite, 'Must have wildcard rewrite to /index.html');
});

test('Seam 4: index.html exists, contains no Leaflet or map tile references, and defines mobile viewport', () => {
  const indexHtmlPath = path.join(REPO_ROOT, 'index.html');
  assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist at web root');

  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Verify mobile-first viewport
  assert.ok(html.includes('<meta name="viewport"'), 'Must have viewport meta tag');
  assert.ok(html.includes('width=device-width'), 'Viewport must specify width=device-width');

  // ADR 0002 acceptance criteria: No Leaflet.js or map tile assets
  assert.ok(!html.toLowerCase().includes('leaflet'), 'Must NOT include Leaflet.js or CSS');
  assert.ok(!html.toLowerCase().includes('openstreetmap'), 'Must NOT include OpenStreetMap tile assets');
  assert.ok(!html.toLowerCase().includes('mapbox'), 'Must NOT include Mapbox assets');

  // Verify proximity radius pill elements
  assert.ok(html.includes('5 km') || html.includes('data-radius="5"'), 'Must include 5 km pill');
  assert.ok(html.includes('10 km') || html.includes('data-radius="10"'), 'Must include 10 km pill');
  assert.ok(html.includes('25 km') || html.includes('data-radius="25"'), 'Must include 25 km pill');
  assert.ok(html.includes('All') || html.includes('data-radius="all"'), 'Must include All radius pill');

  // Verify top header location switcher
  assert.ok(html.includes('location-switcher') || html.includes('header-location'), 'Must include header location element');

  // Seam D: Verify top header filter button and filter view container for Issue #6
  assert.ok(html.includes('filter-header-btn') || html.includes('id="filter-header-btn"'), 'Must include header filter button');
  assert.ok(html.includes('filter-view-overlay') || html.includes('id="filter-view-overlay"'), 'Must include filter view container');
  assert.ok(html.includes('filter-count-badge') || html.includes('id="filter-count-badge"'), 'Must include filter count badge');
});

test('Seam 4: index.html embeds static Open Graph, Twitter Card metadata and header Suggest link', () => {
  const indexHtmlPath = path.join(REPO_ROOT, 'index.html');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Open Graph
  assert.ok(html.includes('<meta property="og:title"'), 'Must include og:title');
  assert.ok(html.includes('<meta property="og:description"'), 'Must include og:description');
  assert.ok(html.includes('<meta property="og:type"'), 'Must include og:type');
  assert.ok(html.includes('<meta property="og:url"'), 'Must include og:url');

  // Twitter Card
  assert.ok(
    html.includes('<meta name="twitter:card"') || html.includes('<meta property="twitter:card"'),
    'Must include twitter:card'
  );
  assert.ok(
    html.includes('<meta name="twitter:title"') || html.includes('<meta property="twitter:title"'),
    'Must include twitter:title'
  );
  assert.ok(
    html.includes('<meta name="twitter:description"') || html.includes('<meta property="twitter:description"'),
    'Must include twitter:description'
  );

  // Header "Suggest an Activity" action
  assert.ok(
    html.includes('suggest-header-btn') || html.includes('suggest-header-link'),
    'Must include suggest link/button in header'
  );
  assert.ok(
    html.includes('mailto:azhidkov@gmail.com'),
    'Header suggest link must point to mailto:azhidkov@gmail.com'
  );
});
