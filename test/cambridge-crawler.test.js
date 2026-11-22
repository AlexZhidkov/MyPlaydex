import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCambridgeCrawler,
  CAMBRIDGE_CONFIG,
  CAMBRIDGE_LGA_CENTROID
} from '../src/crawlers/cambridge-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const CAMBRIDGE_FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/Discover/Whats-On" id="aspnetForm">
    <input type="hidden" name="__SEAMLESSVIEWSTATE" id="__SEAMLESSVIEWSTATE" value="CAMBRIDGE_VS_1" />
    <div class="list-container events-list-container left">
      <div class="list-item-container homepage-show">
        <article>
          <a href="https://www.cambridge.wa.gov.au/Discover/Whats-On/Art-The-Boulevard-Christopher-Hummel">
            <h2 class="list-item-title">Art @ The Boulevard - Christopher Hummel</h2>
            <p class="clearfix">
              <span class="list-item-block-date"><span class="part-date">22</span> <span class="part-month">Nov</span> <span class="part-year">2026</span></span>
              <span class="list-item-block-desc">Graff My Train exhibition at The Boulevard Centre.</span>
            </p>
            <p class="list-item-address">The Boulevard Centre,&nbsp;99 The Boulevard,&nbsp;Floreat&nbsp;6014</p>
            <p class="tagged-as-list"><span class="label">Tagged as:&nbsp;</span><span class="text"><span class="separator">,&nbsp;</span>Arts &amp; Culture<span class="separator">,&nbsp;</span>Community Event</span></p>
          </a>
        </article>
      </div>
      <div class="list-item-container homepage-show">
        <article>
          <a href="https://www.cambridge.wa.gov.au/Discover/Whats-On/Roadworks-Cambridge-Street">
            <h2 class="list-item-title">Cambridge Street Roadworks</h2>
            <p class="clearfix">
              <span class="list-item-block-date"><span class="part-date">25</span> <span class="part-month">Nov</span> <span class="part-year">2026</span></span>
              <span class="list-item-block-desc">Scheduled resurfacing notice.</span>
            </p>
            <p class="list-item-address">Cambridge Street, Wembley 6014</p>
            <p class="tagged-as-list"><span class="label">Tagged as:&nbsp;</span><span class="text">Works</span></p>
          </a>
        </article>
      </div>
    </div>
  </form>
</body></html>`;

test('Cambridge crawler parses OpenCities SSR cards, maps arts category, filters roadworks notice, and resolves coords', async () => {
  const mockFetch = async () => ({
    ok: true,
    async text() {
      return CAMBRIDGE_FIXTURE_HTML;
    }
  });

  const crawler = createCambridgeCrawler({ fetchFn: mockFetch, pageDelayMs: 0, detailDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'cambridge');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, CAMBRIDGE_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 1);

  const [art] = listings;
  assert.equal(art.source, 'cambridge');
  assert.equal(art.title, 'Art @ The Boulevard - Christopher Hummel');
  assert.equal(art.category, 'arts');
  assert.equal(art.organizer.name, 'Town of Cambridge');
  assert.equal(art.start_time, '22 Nov 2026');

  const resolution = resolveActivityVenueAndCoordinates(art, {
    fallbackCentroid: CAMBRIDGE_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...art, venue: { ...art.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.ok(sanitized.id.startsWith('cambridge_'));
  assert.equal(sanitized.schedule.start_date, '2026-11-22');
  assert.equal(sanitized.organizer.id, 'org_town_of_cambridge');
});

test('getDefaultCrawlers registers cambridge under councils group', () => {
  const defaults = getDefaultCrawlers();
  const cambridge = defaults.find(c => c.name === 'cambridge');
  assert.ok(cambridge, 'cambridge should be registered in getDefaultCrawlers()');
  assert.equal(cambridge.group, 'councils');
  assert.deepEqual(cambridge.fallbackCentroid, CAMBRIDGE_LGA_CENTROID);
  assert.equal(CAMBRIDGE_CONFIG.minExpectedListings, 1);
});
