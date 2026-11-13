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

  assert.equal(content.firestore?.rules, 'firestore.rules', 'firebase.json must register firestore.rules');
  assert.ok(content.hosting.ignore.includes('firestore.rules'), 'hosting ignore list must exclude firestore.rules');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'firestore.rules')), 'firestore.rules must exist at repo root');
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

test('Seam 4: Responsive header hides Suggest and Filter text labels on small screens', () => {
  const indexHtmlPath = path.join(REPO_ROOT, 'index.html');
  const stylesCssPath = path.join(REPO_ROOT, 'src', 'styles.css');

  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // Verify dedicated text span elements exist in HTML
  assert.ok(html.includes('suggest-btn-text'), 'HTML must have .suggest-btn-text span');
  assert.ok(html.includes('filter-btn-text'), 'HTML must have .filter-btn-text span');

  // Verify responsive CSS media query hides both text labels on small screens
  assert.ok(css.includes('@media (max-width:'), 'CSS must include a max-width media query for small screens');
  assert.ok(css.includes('.suggest-btn-text') && css.includes('.filter-btn-text'), 'CSS must target both button text spans');
  assert.match(
    css,
    /@media[^{]+\{[^}]*\.suggest-btn-text[^}]*display:\s*none/s,
    'Small screen media query must set display: none on .suggest-btn-text'
  );
  assert.match(
    css,
    /@media[^{]+\{[^}]*\.filter-btn-text[^}]*display:\s*none/s,
    'Small screen media query must set display: none on .filter-btn-text'
  );
});

test('Seam 4: firestore.rules grants public read and denies client write on activities, organizers, and venues while denying regions', () => {
  const rulesPath = path.join(REPO_ROOT, 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  for (const collectionMatch of [
    /match \/activities\/\{activityId\}\s*\{[^}]*allow read:\s*if true;\s*allow write:\s*if false;\s*\}/s,
    /match \/organizers\/\{organizerId\}\s*\{[^}]*allow read:\s*if true;\s*allow write:\s*if false;\s*\}/s,
    /match \/venues\/\{venueId\}\s*\{[^}]*allow read:\s*if true;\s*allow write:\s*if false;\s*\}/s
  ]) {
    assert.match(rules, collectionMatch, `Missing public read / deny write rule for ${collectionMatch}`);
  }

  assert.match(
    rules,
    /match \/regions\/\{regionId\}\s*\{[^}]*allow read,\s*write:\s*if false;\s*\}/s,
    '/regions must remain denied to client reads and writes'
  );
  assert.match(
    rules,
    /match \/\{document=\*\*\}\s*\{[^}]*allow read,\s*write:\s*if false;\s*\}/s,
    'Default catch-all rule must deny read and write'
  );
});

test('Seam 2 (Issue #13): index.html renders 3-tab switcher (Activities | Organizers | Venues) above discovery feed with accessible tab semantics', () => {
  const indexHtmlPath = path.join(REPO_ROOT, 'index.html');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(path.join(REPO_ROOT, 'src', 'styles.css'), 'utf8');

  assert.ok(html.includes('role="tablist"'), 'index.html must include a tablist container');
  assert.ok(html.includes('data-tab="activities"') && html.includes('Activities'), 'Must include Activities tab');
  assert.ok(html.includes('data-tab="organizers"') && html.includes('Organizers'), 'Must include Organizers tab');
  assert.ok(html.includes('data-tab="venues"') && html.includes('Venues'), 'Must include Venues tab');
  assert.ok(html.includes('role="tabpanel"'), 'Feed container must have role="tabpanel"');

  const tabPos = html.indexOf('id="discovery-tabs"');
  const feedPos = html.indexOf('id="feed-container"');
  assert.ok(tabPos !== -1 && feedPos !== -1 && tabPos < feedPos, '3-tab switcher must render above #feed-container');

  // CSS styles active tab with non-color underline indicator
  assert.match(css, /\.discovery-tab/, 'styles.css must style .discovery-tab');
  assert.match(css, /border-block-end:\s*3px solid/, 'styles.css must draw non-color underline indicator for selected tab');
});
