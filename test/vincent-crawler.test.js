import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVincentCrawler,
  VINCENT_CONFIG,
  VINCENT_LGA_CENTROID
} from '../src/crawlers/vincent-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { runCrawlerHarness, getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-01T08:00:00+08:00');

const PAGE_1_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/events/" id="form1">
    <input type="hidden" name="__VIEWSTATE" value="VINCENT_VS_1" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" value="GEN123" />

    <div class="events-dont-miss row">
      <div class="event-item-grid">
        <a class="eventdate" href="/events/perth-battle-and-jam-open-style-7-to-smoke/3865">
          <article class="eventArticle">
            <strong class="date text-uppercase">28 November 2026</strong>
            <h3 class="title h4">Perth Battle &amp; Jam - Open Style 7 to Smoke</h3>
            <strong class="location">Leederville Skate Park, Oxford Street</strong>
          </article>
        </a>
      </div>
      <div class="event-item-grid">
        <a class="eventdate" href="/events/november-is-pride-month/3774">
          <article class="eventArticle">
            <strong class="date text-uppercase">27 November 2026</strong>
            <h3 class="title h4">November is PRIDE month</h3>
            <strong class="location">Various locations</strong>
          </article>
        </a>
      </div>
    </div>

    <div class="event-item-grid">
      <a href="/events/chatty-cafe/3419">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl0_eventArticle">
          <span class="date text-uppercase"><strong>Fri 30 Jan - Fri 27 Nov</strong></span>
          <h3 class="title h4">Chatty Cafe</h3>
        </article>
      </a>
    </div>
    <div class="event-item-grid">
      <a href="/events/mahjong/3709">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl1_eventArticle">
          <span class="date text-uppercase"><strong>Wed 22 Jul - Wed 23 Dec</strong></span>
          <h3 class="title h4">Mahjong</h3>
        </article>
      </a>
    </div>
    <div class="event-item-grid">
      <a href="/events/november-is-pride-month/3774">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl2_eventArticle">
          <span class="date text-uppercase"><strong>Sun 1 Nov - Fri 27 Nov</strong></span>
          <h3 class="title h4">November is PRIDE month</h3>
        </article>
      </a>
    </div>
    <div class="event-item-grid">
      <a href="/events/ordinary-council-meeting/3900">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl3_eventArticle">
          <span class="date text-uppercase"><strong>Tue 17 Nov</strong></span>
          <h3 class="title h4">Ordinary Council Meeting</h3>
        </article>
      </a>
    </div>

    <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_GridPagerBottom" class="RadDataPager">
      <button type="button" name="ctl00$ContentPlaceHolder1$Events_usercontrol$RadListViewGrid$GridPagerBottom$ctl02$NextButton"
        onclick="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$Events_usercontrol$RadListViewGrid$GridPagerBottom$ctl02$NextButton&#39;,&#39;&#39;)"
        class="rdpActionButton rdpPageNext"></button>
    </div>
  </form>
</body></html>`;

const PAGE_2_HTML = `<!DOCTYPE html><html><body>
  <form method="post" action="/events/" id="form1">
    <input type="hidden" name="__VIEWSTATE" value="VINCENT_VS_2" />
    <div class="event-item-grid">
      <a href="/events/perth-battle-and-jam-open-style-7-to-smoke/3865">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl0_eventArticle">
          <span class="date text-uppercase"><strong>Sat 28 Nov</strong></span>
          <h3 class="title h4">Perth Battle &amp; Jam - Open Style 7 to Smoke</h3>
        </article>
      </a>
    </div>
    <div class="event-item-grid">
      <a href="/events/mahjong/2900">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl1_eventArticle">
          <span class="date text-uppercase"><strong>Fri 25 Jul - Fri 18 Dec</strong></span>
          <h3 class="title h4">Mahjong</h3>
        </article>
      </a>
    </div>
    <div class="event-item-grid">
      <a href="/events/online-webinar/3910">
        <article id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_ctrl2_eventArticle">
          <span class="date text-uppercase"><strong>Thu 19 Nov</strong></span>
          <h3 class="title h4">Sustainable Living Webinar (Online Only)</h3>
        </article>
      </a>
    </div>
    <div id="ctl00_ContentPlaceHolder1_Events_usercontrol_RadListViewGrid_GridPagerBottom" class="RadDataPager">
      <button type="button" name="ctl00$ContentPlaceHolder1$Events_usercontrol$RadListViewGrid$GridPagerBottom$ctl02$NextButton"
        onclick="return false;__doPostBack(&#39;ctl00$ContentPlaceHolder1$Events_usercontrol$RadListViewGrid$GridPagerBottom$ctl02$NextButton&#39;,&#39;&#39;)"
        class="rdpActionButton rdpPageNext"></button>
    </div>
  </form>
</body></html>`;

const DETAIL_PAGES = {
  'https://www.vincent.wa.gov.au/events/chatty-cafe/3419': `<!DOCTYPE html><html><body>
    <div class="event-content">
      <h2 class="event-title">Chatty Cafe</h2>
      <article class="event-description"><p>Friendly cuppa and conversation.</p></article>
    </div>
    <div class="event-detail-panel">
      <div class="location-info">
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-clock event-icon"></i></span>10:00 - 11:00am</p>
        <p class="detail-label-container"><span class="detail-label"><i class="far fa-calendar-alt event-icon"></i></span>Friday 30 January - Friday 27 November 2026</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-location-dot event-icon"></i></span>Community Centre, 99 Loftus Street, Leederville</p>
        <p class="hidden"><span class="detail-label"><span id="ContentPlaceHolder1_Events_usercontrol_lblVenue">Venue:</span></span>Community Centre Foyer</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fas fa-usd-circle event-icon"></i></span>Free</p>
        <p class="events-detail-category"><span class="detail-label">Category: </span>Seniors, Test</p>
      </div>
      <div class="contact-info">
        <p class="hidden"><span class="detail-label hidden"><i class="fa-thin fa-phone event-icon"></i></span>City of Vincent</p>
      </div>
    </div>
  </body></html>`,
  'https://www.vincent.wa.gov.au/events/mahjong/3709': `<!DOCTYPE html><html><body>
    <div class="event-content">
      <h2 class="event-title">Mahjong</h2>
      <article class="event-description"><p>Wednesday Mahjong club session.</p></article>
    </div>
    <div class="event-detail-panel">
      <div class="location-info">
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-clock event-icon"></i></span>1:00 - 3:00pm</p>
        <p class="detail-label-container"><span class="detail-label"><i class="far fa-calendar-alt event-icon"></i></span>Wednesday 22 July - Wednesday 23 December 2026</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-location-dot event-icon"></i></span>Vincent Library, 99 Loftus Street, Leederville</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fas fa-usd-circle event-icon"></i></span>Free</p>
        <p class="events-detail-category"><span class="detail-label">Category: </span>Hobbies, Seniors</p>
      </div>
      <div class="contact-info">
        <p class="hidden"><span class="detail-label hidden"></span>Vincent Mahjong Club</p>
        <p><span class="detail-label">Website: </span><a href="https://vincentmahjong.example.org">https://vincentmahjong.example.org</a></p>
      </div>
    </div>
  </body></html>`,
  'https://www.vincent.wa.gov.au/events/mahjong/2900': `<!DOCTYPE html><html><body>
    <div class="event-content">
      <h2 class="event-title">Mahjong</h2>
      <article class="event-description"><p>Friday Mahjong club session.</p></article>
    </div>
    <div class="event-detail-panel">
      <div class="location-info">
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-clock event-icon"></i></span>1:00 - 3:00pm</p>
        <p class="detail-label-container"><span class="detail-label"><i class="far fa-calendar-alt event-icon"></i></span>Friday 25 July - Friday 18 December 2026</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-location-dot event-icon"></i></span>North Perth Town Hall, View Street, North Perth</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fas fa-usd-circle event-icon"></i></span>Free</p>
        <p class="events-detail-category"><span class="detail-label">Category: </span>Craft &amp; Hobbies</p>
      </div>
    </div>
  </body></html>`
};

test('City of Vincent crawler parses featured + RadListViewGrid cards, paginates via RadDataPager POST, hydrates detail pages, and deduplicates IDs', async () => {
  const fetchedUrls = [];
  const crawler = createVincentCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    detailDelayMs: 0,
    fetchFn: async (url, init) => {
      fetchedUrls.push(`${init.method}:${url}`);
      if (url === 'https://www.vincent.wa.gov.au/events/' && init.method === 'GET') {
        return { ok: true, async text() { return PAGE_1_HTML; } };
      }
      if (url === 'https://www.vincent.wa.gov.au/events/' && init.method === 'POST') {
        return { ok: true, async text() { return PAGE_2_HTML; } };
      }
      if (DETAIL_PAGES[url]) {
        return { ok: true, async text() { return DETAIL_PAGES[url]; } };
      }
      throw new Error(`Unexpected fetch: ${init.method} ${url}`);
    }
  });

  assert.equal(crawler.name, 'vincent');
  assert.equal(crawler.group, 'councils');
  assert.equal(crawler.minExpectedListings, 0);
  assert.deepEqual(crawler.fallbackCentroid, VINCENT_LGA_CENTROID);
  assert.equal(VINCENT_CONFIG.defaultOrganizer.id, 'org_city_of_vincent');

  const items = await crawler.fetchListings();

  // Featured cards (3865, 3774) had date+location so detail pages were NOT fetched for them,
  // and duplicates in RadListViewGrid (3774 on page 1, 3865 on page 2) were deduplicated.
  assert.deepEqual(fetchedUrls, [
    'GET:https://www.vincent.wa.gov.au/events/',
    'GET:https://www.vincent.wa.gov.au/events/chatty-cafe/3419',
    'GET:https://www.vincent.wa.gov.au/events/mahjong/3709',
    'POST:https://www.vincent.wa.gov.au/events/',
    'GET:https://www.vincent.wa.gov.au/events/mahjong/2900'
  ]);

  assert.equal(items.length, 5);
  assert.deepEqual(items.map(i => i.source_id), ['3865', '3774', '3419', '3709', '2900']);

  // No hardcoded coordinates emitted by crawler
  for (const item of items) {
    assert.equal(item.coordinates, undefined);
  }

  // Chatty Cafe: hydrated schedule, venue/address, fallback City of Vincent organizer
  const chatty = items.find(i => i.source_id === '3419');
  assert.equal(chatty.category, 'community');
  assert.equal(chatty.organizer.id, 'org_city_of_vincent');
  assert.equal(chatty.organizer.name, 'City of Vincent');
  assert.equal(chatty.address, 'Community Centre, 99 Loftus Street, Leederville');
  const sanitizedChatty = sanitizeActivity({ ...chatty, coordinates: VINCENT_LGA_CENTROID });
  assert.equal(sanitizedChatty.id, 'vincent_3419');
  assert.equal(sanitizedChatty.schedule.start_date, '2026-01-30');
  assert.equal(sanitizedChatty.schedule.end_date, '2026-11-27');
  assert.equal(sanitizedChatty.schedule.start_time, '10:00');
  assert.equal(sanitizedChatty.schedule.end_time, '11:00');

  // Identically titled Mahjong Activities retain distinct IDs and explicit vs fallback organizer
  const mahjongWed = items.find(i => i.source_id === '3709');
  const mahjongFri = items.find(i => i.source_id === '2900');
  assert.equal(mahjongWed.category, 'hobbies');
  assert.equal(mahjongWed.organizer.name, 'Vincent Mahjong Club');
  assert.equal(mahjongWed.organizer.website, 'https://vincentmahjong.example.org/');
  assert.equal(mahjongFri.category, 'hobbies');
  assert.equal(mahjongFri.organizer.name, 'City of Vincent');
});

test('City of Vincent crawler integrates with runCrawlerHarness Venue/suburb/LGA fallback and allows 0 listings without ERR_ZERO_YIELD', async () => {
  // 1. Suburb resolution (Mount Hawthorn) vs LGA centroid fallback (Various locations)
  const crawler = createVincentCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    detailDelayMs: 0,
    fetchFn: async (url) => {
      if (url === 'https://www.vincent.wa.gov.au/events/') {
        return {
          ok: true,
          async text() {
            return `<html><body>
              <a href="/events/pride/3774"><article class="eventArticle">
                <strong class="date">27 November 2026</strong>
                <h3 class="title">November is PRIDE month</h3>
                <strong class="location">Various locations</strong>
              </article></a>
              <a href="/events/skate/3865"><article class="eventArticle">
                <strong class="date">28 November 2026</strong>
                <h3 class="title">Axford Park Acoustic Session</h3>
                <strong class="location">Axford Park, Mount Hawthorn</strong>
              </article></a>
            </body></html>`;
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  let written = [];
  const adapter = {
    async scanVenues() { return []; },
    async scanOrganizers() { return []; },
    async batchUpsertListings(items) {
      written = items;
      return { upserted: items.length };
    }
  };

  const summary = await runCrawlerHarness({
    crawlers: [crawler],
    adapter,
    options: { skipUrlVerification: true, logger: { log() {}, error() {} } }
  });

  assert.equal(summary.successfulCrawlers, 1);
  assert.equal(summary.failedCrawlers, 0);
  assert.equal(written.length, 2);

  const lgaFallback = written.find(i => i.id === 'vincent_3774');
  assert.equal(lgaFallback.needs_review, true);
  assert.equal(lgaFallback.review_reason, 'unmatched_venue');
  assert.deepEqual(lgaFallback.venue.coordinates, VINCENT_LGA_CENTROID);

  const suburbFallback = written.find(i => i.id === 'vincent_3865');
  assert.equal(suburbFallback.needs_review, true);
  assert.equal(suburbFallback.review_reason, 'unmatched_venue');
  assert.deepEqual(suburbFallback.venue.coordinates, { lat: -31.9213, lng: 115.8369 });
  assert.notDeepEqual(suburbFallback.venue.coordinates, VINCENT_LGA_CENTROID);

  // 2. Quiet week with 0 listings does not fail with ERR_ZERO_YIELD
  const emptyCrawler = createVincentCrawler({
    now: TEST_NOW,
    pageDelayMs: 0,
    fetchFn: async () => ({
      ok: true,
      async text() {
        return '<html><body><div class="no-events">No upcoming events</div></body></html>';
      }
    })
  });

  const emptySummary = await runCrawlerHarness({
    crawlers: [emptyCrawler],
    adapter,
    options: { skipUrlVerification: true, logger: { log() {}, error() {} } }
  });
  assert.equal(emptySummary.successfulCrawlers, 1);
  assert.equal(emptySummary.failedCrawlers, 0);
  assert.equal(emptySummary.results[0].status, 'ok');
  assert.equal(emptySummary.results[0].errorCode, null);
});

test('getDefaultCrawlers registers vincent under councils group with minExpectedListings=0', () => {
  const defaults = getDefaultCrawlers();
  const vincent = defaults.find(c => c.name === 'vincent');
  assert.ok(vincent, 'vincent should be registered in getDefaultCrawlers()');
  assert.equal(vincent.group, 'councils');
  assert.equal(vincent.minExpectedListings, 0);
});
