import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchSuburbs,
  PERTH_SUBURB_CENTROIDS,
  getSuburbByPostcodeOrName,
  suburbNameToSlug,
  getSuburbBySlugOrName
} from '../src/perth-centroids.js';

test('Seam 2: PERTH_SUBURB_CENTROIDS contains comprehensive Greater Perth suburbs with valid coordinates', () => {
  assert.ok(Array.isArray(PERTH_SUBURB_CENTROIDS));
  assert.ok(PERTH_SUBURB_CENTROIDS.length >= 50, `Expected at least 50 suburbs, got ${PERTH_SUBURB_CENTROIDS.length}`);

  for (const entry of PERTH_SUBURB_CENTROIDS) {
    assert.ok(entry.name, 'Entry must have a name');
    assert.ok(entry.postcode, `Entry ${entry.name} must have a postcode`);
    assert.ok(typeof entry.lat === 'number' && !Number.isNaN(entry.lat), `Entry ${entry.name} has invalid lat`);
    assert.ok(typeof entry.lng === 'number' && !Number.isNaN(entry.lng), `Entry ${entry.name} has invalid lng`);
    // Greater Perth bounding box: lat ~ -32.8 to -31.4, lng ~ 115.5 to 116.3
    assert.ok(entry.lat < -31.4 && entry.lat > -32.8, `Entry ${entry.name} lat ${entry.lat} outside Perth bounding box`);
    assert.ok(entry.lng > 115.5 && entry.lng < 116.4, `Entry ${entry.name} lng ${entry.lng} outside Perth bounding box`);
  }
});

test('Seam 2: searchSuburbs matches by suburb name prefix and substring', () => {
  const cottesloeMatches = searchSuburbs('Cott');
  assert.ok(cottesloeMatches.length > 0);
  assert.equal(cottesloeMatches[0].name, 'Cottesloe');
  assert.equal(cottesloeMatches[0].postcode, '6011');

  const scarbMatches = searchSuburbs('scarborough');
  assert.ok(scarbMatches.length > 0);
  assert.equal(scarbMatches[0].name, 'Scarborough');
  assert.equal(scarbMatches[0].postcode, '6019');
});

test('Seam 2: searchSuburbs matches by postcode prefix and exact match', () => {
  const postcodeMatches = searchSuburbs('6000');
  assert.ok(postcodeMatches.length > 0);
  assert.ok(postcodeMatches.some(s => s.name === 'Perth' || s.name === 'Perth CBD'));

  const partialPostcode = searchSuburbs('601');
  assert.ok(partialPostcode.length > 0);
  assert.ok(partialPostcode.every(s => s.postcode.startsWith('601')));
});

test('Seam 2: searchSuburbs handles empty input and limits results', () => {
  const emptyQuery = searchSuburbs('');
  assert.ok(emptyQuery.length > 0, 'Empty query should return default/curated presets');
  assert.ok(emptyQuery.length <= 8);

  const limited = searchSuburbs('a', 5);
  assert.equal(limited.length, 5);
});

test('Seam 2: getSuburbByPostcodeOrName accurately resolves exact name or postcode', () => {
  const fremantle = getSuburbByPostcodeOrName('Fremantle');
  assert.ok(fremantle);
  assert.equal(fremantle.name, 'Fremantle');
  assert.equal(fremantle.postcode, '6160');

  const byPostcode = getSuburbByPostcodeOrName('6027');
  assert.ok(byPostcode);
  assert.equal(byPostcode.name, 'Joondalup');

  const notFound = getSuburbByPostcodeOrName('Sydney');
  assert.equal(notFound, null);
});

test('Seam 2: suburbNameToSlug and getSuburbBySlugOrName support clean URL slug resolution', () => {
  // Test slug generation
  assert.equal(suburbNameToSlug('Scarborough'), 'scarborough');
  assert.equal(suburbNameToSlug('Mount Lawley'), 'mount-lawley');
  assert.equal(suburbNameToSlug('East Perth'), 'east-perth');
  assert.equal(suburbNameToSlug('Peppermint Grove'), 'peppermint-grove');
  assert.equal(suburbNameToSlug(''), '');
  assert.equal(suburbNameToSlug(null), '');

  // Test slug and name resolution
  const cottesloe = getSuburbBySlugOrName('cottesloe');
  assert.ok(cottesloe);
  assert.equal(cottesloe.name, 'Cottesloe');
  assert.equal(cottesloe.postcode, '6011');

  const mtLawleySlug = getSuburbBySlugOrName('mount-lawley');
  assert.ok(mtLawleySlug);
  assert.equal(mtLawleySlug.name, 'Mount Lawley');

  const mtLawleyName = getSuburbBySlugOrName('Mount Lawley');
  assert.ok(mtLawleyName);
  assert.equal(mtLawleyName.name, 'Mount Lawley');

  const byPostcode = getSuburbBySlugOrName('6019');
  assert.ok(byPostcode);
  assert.equal(byPostcode.name, 'Scarborough');

  assert.equal(getSuburbBySlugOrName('non-existent-suburb'), null);
});
