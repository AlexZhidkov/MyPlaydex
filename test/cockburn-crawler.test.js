import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKBURN_CONFIG,
  COCKBURN_ENDPOINT,
  COCKBURN_LGA_CENTROID,
  buildCockburnSchedule,
  createCockburnCrawler,
  normalizeCockburnTimeText,
  parseCockburnDetailPage,
  parseCockburnListingPage
} from '../src/crawlers/cockburn-crawler.js';
import { computeActivityExpireAt, sanitizeActivity } from '../src/sanitizer.js';
import { getDefaultCrawlers, runCrawlerHarness } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-10T08:00:00+08:00');

const PAGE_1_HTML = `<!DOCTYPE html><html><body>
  <div id="eventslistingResultsFB" class="eventslisting landingpage hotboxes eventfb">
    <div class="messageblock">4 events</div>
    <ul class="uk-grid eventfb">
      <li class="uk-width-1-1 uk-width-small-1-2 uk-width-large-1-3 uk-flex">
        <div class="landingpage-item">
          <a href="https://www.cockburn.wa.gov.au/City-and-Council/Events-and-News/Events-and-Workshops/Health/Sunset-Yoga">
            <div class="img"><img src="https://cdn.cockburn.wa.gov.au/uploads/yoga.png" alt="Sunset Yoga" /></div>
            <div class="hotbox-item" style="height: auto;margin: 0;">
              <div><span><h2>Sunset Yoga</h2></span></div>
              <div>
                <div><span><i class="uk-icon-map-marker"></i></span><span>Omeo Park</span><br /></div>
                <div><span><i class="uk-icon-clock-o"></i></span><span>6-6:45pm</span><br /></div>
                <div><span><i class="uk-icon-calendar"></i></span><span>22 October-26 November 2026</span><br /></div>
                <div class="eventlandingreText"><span><i class="uk-icon-info-circle"></i></span><span>Thursdays</span><br /></div>
                <div style="position:absolute; bottom:0px; padding-bottom:10px;left: 13px">
                  <div><span style="white-space: nowrap;"> </span></div>
                </div>
              </div>
            </div>
          </a>
        </div>
      </li>
      <li class="uk-width-1-1 uk-width-small-1-2 uk-width-large-1-3 uk-flex">
        <div class="landingpage-item">
          <a href="/City-and-Council/Events-and-News/Events-and-Workshops/ARC/pickleball">
            <div class="hotbox-item">
              <div><span><h2>Pickleball</h2></span></div>
              <div>
                <div><span><i class="uk-icon-map-marker"></i></span><span>Cockburn ARC</span><br /></div>
                <div><span><i class="uk-icon-clock-o"></i></span><span>4-4.45pm</span><br /></div>
                <div class="eventlandingreText"><span><i></i></span><span>Every Tuesday &amp; Friday during term</span><br /></div>
                <div style="position:absolute; bottom:0px; padding-bottom:10px;left: 13px">
                  <div><span style="white-space: nowrap;">Free</span></div>
                </div>
              </div>
            </div>
          </a>
        </div>
      </li>
      <li class="uk-width-1-1 uk-width-small-1-2 uk-width-large-1-3 uk-flex">
        <div class="landingpage-item">
          <a href="/City-and-Council/Events-and-News/Events-and-Workshops/Business/Ordinary-Council-Meeting">
            <div class="hotbox-item">
              <div><span><h2>Ordinary Council Meeting</h2></span></div>
              <div>
                <div><span><i class="uk-icon-map-marker"></i></span><span>Cockburn Administration Building</span><br /></div>
                <div><span><i class="uk-icon-clock-o"></i></span><span>7-9pm</span><br /></div>
                <div><span><i class="uk-icon-calendar"></i></span><span>10 December 2026</span><br /></div>
              </div>
            </div>
          </a>
        </div>
      </li>
    </ul>
    <div class="pagination-wrap">
      <ul id="pagination" class="uk-pagination">
        <li class="uk-disabled"><a class="prev" href="#">Previous</a></li>
        <li class="uk-active"><span>1</span></li>
        <li><a href="javascript:__doPostBack('MainPager','2')" data-id="2">2</a></li>
        <li><a href="javascript:__doPostBack('MainPager','2')" class="next">Next</a></li>
      </ul>
    </div>
    <input id="recordCountValue" value="4" type="hidden" />
  </div>
</body></html>`;

const PAGE_2_HTML = `<!DOCTYPE html><html><body>
  <div id="eventslistingResultsFB">
    <ul class="uk-grid eventfb">
      <li class="uk-width-1-1">
        <div class="landingpage-item">
          <a href="https://www.cockburn.wa.gov.au/City-and-Council/Events-and-News/Events-and-Workshops/Health/Sunset-Yoga">
            <div class="hotbox-item"><h2>Sunset Yoga</h2></div>
          </a>
        </div>
      </li>
      <li class="uk-width-1-1">
        <div class="landingpage-item">
          <a href="/City-and-Council/Events-and-News/Events-and-Workshops/Environment/Celebration-Bunting-Workshop">
            <div class="hotbox-item">
              <div><span><h2>Celebration Bunting Workshop</h2></span></div>
              <div>
                <div><span><i class="uk-icon-map-marker"></i></span><span>The Hub 6163</span><br /></div>
                <div><span><i class="uk-icon-clock-o"></i></span><span>10am-Midday</span><br /></div>
                <div><span><i class="uk-icon-calendar"></i></span><span>27 November 2026</span><br /></div>
                <div style="position:absolute; bottom:0px;"><span style="white-space: nowrap;">Free</span></div>
              </div>
            </div>
          </a>
        </div>
      </li>
      <li class="uk-width-1-1">
        <div class="landingpage-item">
          <a href="/City-and-Council/Events-and-News/Events-and-Workshops/ARC/Past-Swim-Clinic">
            <div class="hotbox-item">
              <div><span><h2>Past Swim Clinic</h2></span></div>
              <div>
                <div><span><i class="uk-icon-map-marker"></i></span><span>Cockburn ARC</span><br /></div>
                <div><span><i class="uk-icon-clock-o"></i></span><span>Midday-2pm</span><br /></div>
                <div><span><i class="uk-icon-calendar"></i></span><span>14 October 2026</span><br /></div>
              </div>
            </div>
          </a>
        </div>
      </li>
    </ul>
    <div class="pagination-wrap">
      <ul id="pagination" class="uk-pagination">
        <li><a href="javascript:__doPostBack('MainPager','1')" class="prev">Previous</a></li>
        <li class="uk-active"><span>2</span></li>
        <li class="uk-disabled"><a href="javascript:__doPostBack('MainPager','2')" class="next">Next</a></li>
      </ul>
    </div>
    <input id="recordCountValue" value="4" type="hidden" />
  </div>
</body></html>`;

const SUNSET_YOGA_DETAIL_HTML = `<!DOCTYPE html><html><body>
  <div class="eventsdetail">
    <div class="eventsummarydetail">
      <div><span class="eventsdetail-time clock">6-6:45pm</span></div>
      <div><span class="eventsdetail-time calendar">22 October-26 November 2026</span></div>
      <div><span class="eventsdetail-time information">Thursdays</span></div>
    </div>
    <div id="addtocalendar"
      data-title="Sunset Yoga"
      data-startdate="October 22, 2026"
      data-enddate="November 26, 2026"
      data-starttime="18:00"
      data-endtime="06:45"
      data-add="Omeo Park, 21 Socrates Parade NORTH COOGEE WA 6163"
      class="uk-modal"></div>
    <h2>About the event </h2>
    <p>Experience tranquility as the sun sets over Omeo Park!</p>
    <p>All abilities welcome.</p>
    <div data-uk-accordion="{collapse:true}" class="uk-accordion eventdetail">
      <span class="uk-accordion-title eventdetail">Price<span class="sr-only">Collapse</span></span>
      <div class="uk-accordion-content">$5 per person for 6 sessions!</div>
    </div>
    <div class="eventsdetail information">
      <div class="location">
        <h2>Omeo Park</h2>
        <p>21 Socrates Parade<br />NORTH COOGEE, WA 6163</p>
        <p class="mapdetail">Accessibility notice.</p>
      </div>
      <div class="eventsdetail-contact">
        <h2>More information and contact</h2>
        <p><span class="sr-only">Contact Title</span> Healthy Cockburn</p>
        <p class="eventsdetail-icon icon-email"><a href="/cdn-cgi/l/email-protection#1234">[email&#160;protected]</a></p>
        <p class="eventsdetail-icon icon-phone"><a href="tel:08 9411 3444">08 9411 3444</a></p>
      </div>
    </div>
  </div>
</body></html>`;

const EXTERNAL_ORG_DETAIL_HTML = `<!DOCTYPE html><html><body>
  <div class="eventsdetail">
    <h2>About the event</h2>
    <p>Upcycling textiles with local sustainability educators.</p>
    <div class="location">
      <h2>The Hub 6163</h2>
      <p>1 Starling Street<br />HAMILTON HILL, WA 6163</p>
    </div>
    <div class="eventsdetail-contact">
      <h2>More information and contact</h2>
      <p><span class="sr-only">Contact Title</span> Fremantle Eco Collective</p>
      <p class="eventsdetail-icon icon-email"><a href="mailto:hello@freoeco.org.au">hello@freoeco.org.au</a></p>
      <p><a href="https://freoeco.org.au">Website</a></p>
    </div>
  </div>
</body></html>`;

test('parseCockburnListingPage parses #eventslistingResultsFB cards, badges, department tags, and pagination', () => {
  const page1 = parseCockburnListingPage(PAGE_1_HTML, { baseUrl: COCKBURN_CONFIG.baseUrl, page: 1 });
  assert.equal(page1.totalRecords, 4);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.cards.length, 3);

  assert.equal(page1.cards[0].sourceId, 'health_sunset_yoga');
  assert.equal(page1.cards[0].venueName, 'Omeo Park');
  assert.equal(page1.cards[0].timeText, '6-6:45pm');
  assert.equal(page1.cards[0].dateText, '22 October-26 November 2026');
  assert.equal(page1.cards[0].infoText, 'Thursdays');
  assert.equal(page1.cards[0].badgeText, '');
  assert.equal(page1.cards[0].departmentTag, 'health wellbeing');

  assert.equal(page1.cards[1].sourceId, 'arc_pickleball');
  assert.equal(page1.cards[1].badgeText, 'Free');
  assert.equal(page1.cards[1].dateText, '');
  assert.equal(page1.cards[1].departmentTag, 'sports recreation fitness');

  const page2 = parseCockburnListingPage(PAGE_2_HTML, { baseUrl: COCKBURN_CONFIG.baseUrl, page: 2 });
  assert.equal(page2.hasMore, false);
});

test('parseCockburnDetailPage extracts description, Price, full address, ignores buggy data-endtime, and suppresses internal Cockburn contact', () => {
  const internalDetail = parseCockburnDetailPage(SUNSET_YOGA_DETAIL_HTML);
  assert.equal(internalDetail.description, 'Experience tranquility as the sun sets over Omeo Park! All abilities welcome.');
  assert.equal(internalDetail.cost, '$5 per person for 6 sessions!');
  assert.equal(internalDetail.venueName, 'Omeo Park');
  assert.equal(internalDetail.address, '21 Socrates Parade, NORTH COOGEE, WA 6163');
  assert.equal(internalDetail.addToCalStartDate, 'October 22, 2026');
  assert.equal(internalDetail.addToCalEndDate, 'November 26, 2026');
  assert.equal(internalDetail.organizer, undefined);

  const externalDetail = parseCockburnDetailPage(EXTERNAL_ORG_DETAIL_HTML);
  assert.deepEqual(externalDetail.organizer, {
    name: 'Fremantle Eco Collective',
    website: 'https://freoeco.org.au'
  });
});

test('normalizeCockburnTimeText and buildCockburnSchedule handle finite TTL ranges and undated weekly programs', () => {
  assert.equal(normalizeCockburnTimeText('6-6:45pm'), '6pm - 6:45pm');
  assert.equal(normalizeCockburnTimeText('10am-Midday'), '10am-12pm');
  assert.equal(normalizeCockburnTimeText('Midday-2pm'), '12pm-2pm');

  const finite = buildCockburnSchedule({
    dateText: '22 October-26 November 2026',
    addToCalStartDate: 'October 22, 2026',
    addToCalEndDate: 'November 26, 2026',
    timeText: '6-6:45pm',
    infoText: 'Thursdays'
  });
  assert.equal(finite.recurrence, 'none');

  const finiteDoc = sanitizeActivity({
    source: 'cockburn',
    source_id: 'health-sunset-yoga',
    title: 'Sunset Yoga',
    category: 'health',
    venue_name: 'Omeo Park',
    coordinates: { lat: -32.11, lng: 115.76 },
    start_time: finite.startTime,
    recurrence: finite.recurrence,
    external_url: 'https://www.cockburn.wa.gov.au/City-and-Council/Events-and-News/Events-and-Workshops/Health/Sunset-Yoga'
  });
  assert.equal(finiteDoc.schedule.start_date, '2026-10-22');
  assert.equal(finiteDoc.schedule.end_date, '2026-11-26');
  assert.equal(finiteDoc.schedule.start_time, '18:00');
  assert.equal(finiteDoc.schedule.end_time, '18:45');
  assert.equal(finiteDoc.schedule.recurrence, 'none');
  assert.ok(computeActivityExpireAt(finiteDoc.schedule) instanceof Date);

  const weekly = buildCockburnSchedule({
    dateText: '',
    timeText: '4-4.45pm',
    infoText: 'Every Tuesday & Friday during term'
  });
  assert.equal(weekly.recurrence, 'weekly');

  const weeklyDoc = sanitizeActivity({
    source: 'cockburn',
    source_id: 'arc-pickleball',
    title: 'Pickleball',
    category: 'sports',
    venue_name: 'Cockburn ARC',
    coordinates: { lat: -32.1278, lng: 115.8569 },
    start_time: weekly.startTime,
    recurrence: weekly.recurrence,
    external_url: 'https://www.cockburn.wa.gov.au/City-and-Council/Events-and-News/Events-and-Workshops/ARC/pickleball'
  });
  assert.equal(weeklyDoc.schedule.recurrence, 'weekly');
  assert.equal(weeklyDoc.schedule.end_date, null);
  assert.equal(weeklyDoc.schedule.start_time, '16:00');
  assert.equal(weeklyDoc.schedule.end_time, '16:45');
  assert.equal(weeklyDoc.schedule.day_of_week, 2);
  assert.equal(computeActivityExpireAt(weeklyDoc.schedule), null);
});

test('createCockburnCrawler paginates, deduplicates, hydrates details, skips expired cards, and falls back gracefully on detail failure', async () => {
  const requestedUrls = [];
  const crawler = createCockburnCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    detailDelayMs: 0,
    fetchFn: async (url) => {
      requestedUrls.push(url);
      if (url === COCKBURN_ENDPOINT) {
        return { ok: true, async text() { return PAGE_1_HTML; } };
      }
      if (url === `${COCKBURN_ENDPOINT}?page=2`) {
        return { ok: true, async text() { return PAGE_2_HTML; } };
      }
      if (url.endsWith('/Health/Sunset-Yoga')) {
        return { ok: true, async text() { return SUNSET_YOGA_DETAIL_HTML; } };
      }
      if (url.endsWith('/ARC/pickleball')) {
        return { ok: false, status: 500, statusText: 'Server Error' };
      }
      if (url.endsWith('/Environment/Celebration-Bunting-Workshop')) {
        return { ok: true, async text() { return EXTERNAL_ORG_DETAIL_HTML; } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  assert.equal(crawler.name, 'cockburn');
  assert.equal(crawler.group, 'councils');
  assert.equal(crawler.localOnly, true);
  assert.deepEqual(crawler.fallbackCentroid, COCKBURN_LGA_CENTROID);

  const items = await crawler.fetchListings();
  assert.equal(items.length, 3);
  assert.ok(!requestedUrls.some(u => u.includes('Ordinary-Council-Meeting')));
  assert.ok(!requestedUrls.some(u => u.includes('Past-Swim-Clinic')));

  const yoga = items.find(i => i.source_id === 'health_sunset_yoga');
  assert.equal(yoga.category, 'health');
  assert.equal(yoga.is_free, false);
  assert.equal(yoga.display_price, '$5 per person for 6 sessions!');
  assert.equal(yoga.organizer.name, 'City of Cockburn');
  assert.equal(yoga.address, '21 Socrates Parade, NORTH COOGEE, WA 6163');

  const pickleball = items.find(i => i.source_id === 'arc_pickleball');
  assert.equal(pickleball.category, 'sports');
  assert.equal(pickleball.is_free, true);
  assert.equal(pickleball.display_price, 'Free');
  assert.equal(pickleball.recurrence, 'weekly');

  const bunting = items.find(i => i.source_id === 'environment_celebration_bunting_workshop');
  assert.equal(bunting.category, 'travel');
  assert.equal(bunting.organizer.name, 'Fremantle Eco Collective');
  assert.equal(bunting.is_free, true);
});

test('Cockburn crawler integrates with runCrawlerHarness suburb centroid fallback and City of Cockburn attribution', async () => {
  const crawler = createCockburnCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    detailDelayMs: 0,
    fetchFn: async (url) => {
      if (url === COCKBURN_ENDPOINT) {
        return {
          ok: true,
          async text() {
            return PAGE_1_HTML.replace(
              '<li><a href="javascript:__doPostBack(\'MainPager\',\'2\')" class="next">Next</a></li>',
              '<li class="uk-disabled"><a href="#" class="next">Next</a></li>'
            );
          }
        };
      }
      if (url.endsWith('/Health/Sunset-Yoga')) {
        return { ok: true, async text() { return SUNSET_YOGA_DETAIL_HTML; } };
      }
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
  });

  let written = [];
  const mockAdapter = {
    async scanVenues() { return []; },
    async scanOrganizers() { return []; },
    async batchUpsertListings(items) {
      written = items;
      return { upserted: items.length };
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter: mockAdapter,
    options: {
      skipUrlVerification: true,
      logger: { log() {}, error() {} }
    }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.totalValid, 2);
  const yoga = written.find(i => i.id === 'cockburn_health_sunset_yoga');
  assert.ok(yoga);
  // Matches Coogee (6166) centroid or Cockburn Central fallback within Perth
  assert.equal(yoga.organizer.id, 'org_city_of_cockburn');
  assert.equal(yoga.venue.id, null);
  assert.equal(yoga.needs_review, true);
  assert.equal(yoga.review_reason, 'unmatched_venue');

  const pickleball = written.find(i => i.id === 'cockburn_arc_pickleball');
  assert.ok(pickleball);
  assert.deepEqual(pickleball.venue.coordinates, COCKBURN_LGA_CENTROID);
  assert.equal(pickleball.schedule.recurrence, 'weekly');
});

test('getDefaultCrawlers excludes cockburn by default and marks cockburn localOnly', () => {
  const defaults = getDefaultCrawlers();
  assert.equal(defaults.find(c => c.name === 'cockburn'), undefined);

  const optedIn = getDefaultCrawlers({ includeCockburn: true });
  const cockburn = optedIn.find(c => c.name === 'cockburn');
  assert.ok(cockburn);
  assert.equal(cockburn.group, 'councils');
  assert.equal(cockburn.localOnly, true);
});
