import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve('.');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

test('Seam 4: firebase.json exists and cleanly configures static hosting SPA rewrites', () => {
  const firebaseJsonPath = path.join(REPO_ROOT, 'firebase.json');
  assert.ok(fs.existsSync(firebaseJsonPath), 'firebase.json must exist');

  const content = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
  assert.ok(content.hosting, 'firebase.json must contain hosting block');
  assert.equal(content.hosting.public, 'public', 'hosting block must set public directory to public');
  assert.ok(Array.isArray(content.hosting.rewrites), 'hosting block must define rewrites');

  const spaRewrite = content.hosting.rewrites.find(r => r.source === '**' && r.destination === '/index.html');
  assert.ok(spaRewrite, 'Must have wildcard rewrite to /index.html');

  assert.equal(content.firestore?.rules, 'firestore.rules', 'firebase.json must register firestore.rules');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'firestore.rules')), 'firestore.rules must exist at repo root');
});

test('Seam 4: index.html exists, contains no Leaflet or map tile references, and defines mobile viewport', () => {
  const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
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
  const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
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
  const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
  const stylesCssPath = path.join(PUBLIC_DIR, 'styles.css');

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
  const indexHtmlPath = path.join(PUBLIC_DIR, 'index.html');
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

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

test('Seam 5: styles.css delivers responsive filter views and location gate for mobile screens', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

  // Verify body overflow-x guard and modal-open lock
  assert.match(css, /overflow-x:\s*hidden/, 'CSS must protect against horizontal overflow');
  assert.match(css, /body\.modal-open\s*\{[^}]*overflow:\s*hidden/, 'CSS must support modal-open scroll lock');

  // Verify location-gate-overlay and location-gate-card responsive scrollability
  assert.match(css, /\.location-gate-overlay\s*\{[^}]*overflow-y:\s*auto/, 'location-gate-overlay must be scrollable on small screens');
  assert.match(css, /\.location-gate-card\s*\{[^}]*margin:\s*auto/, 'location-gate-card must use margin: auto to prevent negative overflow');
  assert.match(css, /\.location-gate-card\s*\{[^}]*max-height:/, 'location-gate-card must constrain max-height');

  // Verify small screen media queries for filters and overlays
  assert.ok(
    css.includes('@media (max-width: 640px)') &&
      css.includes('.location-gate-card') &&
      css.includes('.location-switcher-btn') &&
      css.includes('.filter-view-footer'),
    'Must adapt location-gate-card, location-switcher-btn, and filter-view-footer for small screens'
  );
});

test('Seam 6: styles.css delivers responsive venue cards and feed container without horizontal blowout', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

  // Verify grid tracks use minmax(0, 1fr) to prevent blowout from unwrapped content
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'feed-container must use minmax(0, 1fr) to prevent overflow');

  // Verify cards and tiers enforce min-width: 0 and box-sizing
  assert.match(css, /\.activity-card\s*\{[^}]*min-width:\s*0/, 'activity-card must specify min-width: 0');
  assert.match(css, /\.activity-card\s*\{[^}]*max-width:\s*100%/, 'activity-card must specify max-width: 100%');
  assert.match(css, /\.card-venue-row[^{]*\{[^}]*min-width:\s*0/, 'card-venue-row must specify min-width: 0');
  assert.match(css, /\.venue-name\s*\{[^}]*min-width:\s*0/, 'venue-name must specify min-width: 0');

  // Verify venue and organizer cards wrap full addresses on mobile
  assert.match(css, /\.venue-card\s+\.card-venue-row\s+\.venue-name[^{]*\{[^}]*white-space:\s*normal/, 'venue-card address must wrap cleanly');
  assert.match(css, /\.venue-card\s+\.card-venue-row\s+\.venue-name[^{]*\{[^}]*word-break:\s*break-word/, 'venue-card address must break words to fit screen');
});

test('SEO assets (og-card.png, robots.txt, sitemap.xml) exist and are deployable', () => {
  const ogCardPath = path.join(PUBLIC_DIR, 'og-card.png');
  assert.ok(fs.existsSync(ogCardPath), 'og-card.png must exist at web root');
  const pngBuffer = fs.readFileSync(ogCardPath);
  assert.equal(pngBuffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'og-card.png must be a valid PNG');
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  assert.equal(width, 1200, 'og-card.png width must be 1200px');
  assert.equal(height, 630, 'og-card.png height must be 630px');

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes('<meta property="og:image:width" content="1200" />'), 'index.html must declare og:image:width');
  assert.ok(html.includes('<meta property="og:image:height" content="630" />'), 'index.html must declare og:image:height');

  const robotsPath = path.join(PUBLIC_DIR, 'robots.txt');
  assert.ok(fs.existsSync(robotsPath), 'robots.txt must exist at web root');
  const robots = fs.readFileSync(robotsPath, 'utf8');
  assert.match(robots, /^Allow:\s*\/$/m, 'robots.txt must allow crawling /');
  assert.match(robots, /^Sitemap:\s*https:\/\/myplaydex\.web\.app\/sitemap\.xml$/m, 'robots.txt must reference canonical sitemap.xml');

  const sitemapPath = path.join(PUBLIC_DIR, 'sitemap.xml');
  assert.ok(fs.existsSync(sitemapPath), 'sitemap.xml must exist at web root');
  const sitemap = fs.readFileSync(sitemapPath, 'utf8');
  assert.ok(sitemap.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), 'sitemap.xml must use sitemaps.org schema');
  assert.ok(sitemap.includes('<loc>https://myplaydex.web.app/</loc>'), 'sitemap.xml must include canonical homepage URL');

  const firebaseJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'firebase.json'), 'utf8'));
  const ignored = firebaseJson.hosting?.ignore || [];
  for (const asset of ['og-card.png', 'robots.txt', 'sitemap.xml']) {
    assert.ok(!ignored.includes(asset), `firebase.json must not ignore ${asset}`);
  }
});

test('firebase.json configures HTTP security headers globally while preserving asset caching', () => {
  const firebaseJsonPath = path.join(REPO_ROOT, 'firebase.json');
  const content = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
  const headerRules = content.hosting?.headers;
  assert.ok(Array.isArray(headerRules), 'hosting.headers must be an array');

  const globalRule = headerRules.find((rule) => rule.source === '**');
  assert.ok(globalRule && Array.isArray(globalRule.headers), 'Must define global "**" header rule');

  const headersByKey = new Map(globalRule.headers.map((h) => [h.key, h.value]));
  assert.equal(headersByKey.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headersByKey.get('X-Frame-Options'), 'DENY');
  assert.equal(headersByKey.get('Referrer-Policy'), 'strict-origin-when-cross-origin');

  const permissionsPolicy = headersByKey.get('Permissions-Policy');
  assert.ok(permissionsPolicy, 'Permissions-Policy must be set');
  assert.ok(permissionsPolicy.includes('geolocation=(self)'), 'Permissions-Policy must keep geolocation=(self)');
  assert.ok(permissionsPolicy.includes('camera=()'), 'Permissions-Policy must restrict camera');
  assert.ok(permissionsPolicy.includes('microphone=()'), 'Permissions-Policy must restrict microphone');

  const csp = headersByKey.get('Content-Security-Policy');
  assert.ok(csp, 'Content-Security-Policy must be set');
  const directives = new Map(
    csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [name, ...rest] = part.split(/\s+/);
      return [name, rest.join(' ')];
    })
  );

  assert.equal(directives.get('default-src'), "'self'");
  assert.equal(directives.get('frame-ancestors'), "'none'");

  const scriptSrc = directives.get('script-src') || '';
  assert.ok(scriptSrc.includes("'self'") && scriptSrc.includes('https://www.gstatic.com'), 'script-src must allow self and gstatic Firebase SDK');
  assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), 'script-src must not allow unsafe-inline or unsafe-eval');

  const connectSrc = directives.get('connect-src') || '';
  for (const origin of [
    "'self'",
    'https://firestore.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://www.google-analytics.com'
  ]) {
    assert.ok(connectSrc.includes(origin), `connect-src must include ${origin}`);
  }

  const assetCacheRule = headerRules.find((rule) => rule.source === '**/*.@(js|css)');
  assert.ok(assetCacheRule, 'Must preserve existing **/*.@(js|css) Cache-Control rule');
  assert.ok(
    assetCacheRule.headers?.some((h) => h.key === 'Cache-Control' && h.value === 'max-age=3600'),
    'Asset cache rule must keep Cache-Control: max-age=3600'
  );
});

test('Favicon and web manifest assets exist, match dimensions, and are linked in index.html', () => {
  const svgPath = path.join(PUBLIC_DIR, 'favicon.svg');
  assert.ok(fs.existsSync(svgPath), 'favicon.svg must exist at web root');
  const svg = fs.readFileSync(svgPath, 'utf8');
  assert.ok(svg.includes('<svg') && svg.includes('#0284c7'), 'favicon.svg must be an SVG using brand color #0284c7');

  const icoPath = path.join(PUBLIC_DIR, 'favicon.ico');
  assert.ok(fs.existsSync(icoPath), 'favicon.ico must exist at web root');
  const icoBuffer = fs.readFileSync(icoPath);
  assert.equal(icoBuffer.subarray(0, 4).toString('hex'), '00000100', 'favicon.ico must have valid ICO magic bytes');

  const pngSpecs = [
    ['apple-touch-icon.png', 180, 180],
    ['icon-192.png', 192, 192],
    ['icon-512.png', 512, 512]
  ];
  for (const [filename, expectedWidth, expectedHeight] of pngSpecs) {
    const filePath = path.join(PUBLIC_DIR, filename);
    assert.ok(fs.existsSync(filePath), `${filename} must exist at web root`);
    const buf = fs.readFileSync(filePath);
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filename} must be a valid PNG`);
    assert.equal(buf.readUInt32BE(16), expectedWidth, `${filename} width must be ${expectedWidth}px`);
    assert.equal(buf.readUInt32BE(20), expectedHeight, `${filename} height must be ${expectedHeight}px`);
  }

  const manifestPath = path.join(PUBLIC_DIR, 'site.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'site.webmanifest must exist at web root');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.theme_color, '#0284c7', 'site.webmanifest must set theme_color to #0284c7');
  const iconSrcs = (manifest.icons || []).map((icon) => icon.src);
  assert.ok(iconSrcs.includes('/icon-192.png'), 'site.webmanifest must include /icon-192.png');
  assert.ok(iconSrcs.includes('/icon-512.png'), 'site.webmanifest must include /icon-512.png');

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(html.includes('<meta name="theme-color" content="#0284c7" />'), 'index.html must include theme-color meta');
  assert.ok(html.includes('<link rel="icon" href="/favicon.ico" sizes="48x48" />'), 'index.html must link favicon.ico');
  assert.ok(html.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />'), 'index.html must link favicon.svg');
  assert.ok(html.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />'), 'index.html must link apple-touch-icon.png');
  assert.ok(html.includes('<link rel="manifest" href="/site.webmanifest" />'), 'index.html must link site.webmanifest');

  const firebaseJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'firebase.json'), 'utf8'));
  const ignored = firebaseJson.hosting?.ignore || [];
  for (const asset of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest']) {
    assert.ok(!ignored.includes(asset), `firebase.json must not ignore ${asset}`);
  }
});

