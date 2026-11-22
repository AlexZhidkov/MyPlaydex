import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGosnellsCrawler,
  GOSNELLS_CONFIG,
  GOSNELLS_LGA_CENTROID
} from '../src/crawlers/gosnells-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const GOSNELLS_FIXTURE_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/Events-Directory" id="aspnetForm">
    <input type="hidden" name="__SEAMLESSVIEWSTATE" id="__SEAMLESSVIEWSTATE" value="GOSNELLS_VS_1" />
    <div class="list-container events-list-container left">
      <div class="list-item-container homepage-show">
        <article>
          <a href="https://www.gosnells.wa.gov.au/Events-Directory/Youth-Families-Events/Tumble-Tots-1-2-years">
            <h2 class="list-item-title">Tumble Tots 1 - 2 years</h2>
            <p class="clearfix">
              <span class="list-item-block-date"><span class="part-date">23</span> <span class="part-month">Nov</span> <span class="part-year">2026</span></span>
              <span class="list-item-block-desc">High-energy sessions designed to boost coordination, strength, motor skills, and imagination.</span>
            </p>
            <p class="list-item-address">Mills Park, 86 Brixton Street, Beckenham 6107</p>
            <p class="tagged-as-list"><span class="label">Tagged as:&nbsp;</span><span class="text"><span class="separator">,&nbsp;</span>Event<span class="separator">,&nbsp;</span>Childrens Program</span></p>
          </a>
        </article>
      </div>
      <div class="list-item-container homepage-show">
        <article>
          <a href="https://www.gosnells.wa.gov.au/Events-Directory/Sports/Twilight-Social-Netball">
            <h2 class="list-item-title">Twilight Social Netball</h2>
            <p class="clearfix">
              <span class="list-item-block-date"><span class="part-date">26</span> <span class="part-month">Nov</span> <span class="part-year">2026</span></span>
              <span class="list-item-block-desc">Mixed social netball under lights.</span>
            </p>
            <p class="list-item-address">Sutherlands Park, Huntingdale 6110</p>
            <p class="tagged-as-list"><span class="label">Tagged as:&nbsp;</span><span class="text">Sports &amp; Recreation</span></p>
          </a>
        </article>
      </div>
      <div class="list-item-container homepage-show">
        <article>
          <a href="https://www.gosnells.wa.gov.au/Events-Directory/Council/Ordinary-Council-Meeting">
            <h2 class="list-item-title">Ordinary Council Meeting</h2>
            <p class="clearfix">
              <span class="list-item-block-date"><span class="part-date">24</span> <span class="part-month">Nov</span> <span class="part-year">2026</span></span>
              <span class="list-item-block-desc">Monthly council meeting.</span>
            </p>
            <p class="list-item-address">Civic Centre, Gosnells 6110</p>
            <p class="tagged-as-list"><span class="label">Tagged as:&nbsp;</span><span class="text">Council</span></p>
          </a>
        </article>
      </div>
    </div>
  </form>
</body></html>`;

test('Gosnells crawler parses OpenCities SSR cards, maps categories, filters civic noise, and resolves LGA/suburb coords', async () => {
  const mockFetch = async () => ({
    ok: true,
    async text() {
      return GOSNELLS_FIXTURE_HTML;
    }
  });

  const crawler = createGosnellsCrawler({ fetchFn: mockFetch, pageDelayMs: 0, detailDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'gosnells');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, GOSNELLS_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  const [tumbleTots, netball] = listings;
  assert.equal(tumbleTots.source, 'gosnells');
  assert.equal(tumbleTots.title, 'Tumble Tots 1 - 2 years');
  assert.equal(tumbleTots.category, 'family');
  assert.equal(tumbleTots.organizer.name, 'City of Gosnells');
  assert.equal(tumbleTots.start_time, '23 Nov 2026');

  const resolution = resolveActivityVenueAndCoordinates(tumbleTots, {
    fallbackCentroid: GOSNELLS_LGA_CENTROID
  });
  const sanitized = sanitizeActivity(
    applyVenueResolution(
      { ...tumbleTots, venue: { ...tumbleTots.venue, coordinates: resolution.coordinates } },
      resolution
    )
  );
  assert.ok(sanitized.id.startsWith('gosnells_'));
  assert.equal(sanitized.schedule.start_date, '2026-11-23');
  assert.equal(sanitized.organizer.id, 'org_city_of_gosnells');

  assert.equal(netball.category, 'sports');
});

test('getDefaultCrawlers registers gosnells under councils group', () => {
  const defaults = getDefaultCrawlers();
  const gosnells = defaults.find(c => c.name === 'gosnells');
  assert.ok(gosnells, 'gosnells should be registered in getDefaultCrawlers()');
  assert.equal(gosnells.group, 'councils');
  assert.deepEqual(gosnells.fallbackCentroid, GOSNELLS_LGA_CENTROID);
  assert.equal(GOSNELLS_CONFIG.minExpectedListings, 1);
});
