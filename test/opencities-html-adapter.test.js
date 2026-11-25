import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DETAIL_DELAY_MS,
  normalizeTimeRangeText,
  parseOpenCitiesListingPage,
  parseOpenCitiesDetailPage,
  createOpenCitiesHtmlCrawler
} from '../src/crawlers/opencities-html-adapter.js';
import { sanitizeActivity } from '../src/sanitizer.js';

const TEST_NOW = new Date('2026-11-01T08:00:00+08:00');

test('Slice 1: parses semantic OpenCities and Granicus HTML cards without detail hydration when required fields are present', async () => {
  const html = `<!DOCTYPE html><html><body>
    <section class="oc-events-listing">
      <article data-event-id="oc-101" data-lat="-32.0795" data-lng="115.9975">
        <h2 class="list-item-title">
          <a href="/Events-Directory/Sports/Twilight-Netball-&amp;-Social">Twilight Netball &amp; Social</a>
        </h2>
        <div class="event-dates">
          <time datetime="2026-11-20T18:00:00+08:00">20 Nov 2026</time>
          <span class="event-time">6:00pm - 8:00pm</span>
        </div>
        <div class="location-info">Mills Park Centre, Beckenham WA 6107</div>
        <div class="event-description">Casual social netball games for adults.</div>
        <div class="event-categories">Sport, Netball</div>
        <div class="event-cost">$5</div>
        <div class="event-organizer">Gosnells Netball Association</div>
      </article>
      <article>
        <a href="https://example.wa.gov.au/Events-Directory/Youth-Families-Events/Tumble-Tots-1-2-years">
          <h2 class="list-item-title">Tumble Tots 1 &amp; 2 years</h2>
          <p class="clearfix">
            <span class="list-item-block-date">
              <span class="part-date">23</span>
              <span class="part-month">Nov</span>
              <span class="part-year">2026</span>
            </span>
            <span class="list-item-block-desc">
              Fun toddler movement session for early years.
            </span>
          </p>
          <p class="list-item-address">Addie Mills Centre,&nbsp;2 Astley Street,&nbsp;Gosnells&nbsp;6110</p>
          <p class="tagged-as-list">
            <span class="label">Tagged as:&nbsp;</span><span class="text"><span class="separator">,&nbsp;</span>Event<span class="separator">,&nbsp;</span>Childrens Program</span>
          </p>
        </a>
      </article>
    </section>
  </body></html>`;

  const config = {
    source: 'test_opencities',
    label: 'Test OpenCities',
    endpoint: 'https://example.wa.gov.au/Events-Directory',
    baseUrl: 'https://example.wa.gov.au',
    defaultOrganizer: {
      id: 'org_test_council',
      name: 'Test Council',
      website: 'https://example.wa.gov.au'
    }
  };

  const parsed = parseOpenCitiesListingPage(html, config);
  assert.equal(parsed.cards.length, 2);
  assert.equal(parsed.hasMore, false);

  const firstCard = parsed.cards[0];
  assert.equal(firstCard.sourceId, 'oc-101');
  assert.equal(firstCard.title, 'Twilight Netball & Social');
  assert.equal(firstCard.startDateTime, '2026-11-20T18:00:00+08:00');
  assert.equal(firstCard.location, 'Mills Park Centre, Beckenham WA 6107');
  assert.deepEqual(firstCard.tags, ['Sport', 'Netball']);
  assert.equal(firstCard.organizer.name, 'Gosnells Netball Association');
  assert.deepEqual(firstCard.coordinates, { lat: -32.0795, lng: 115.9975 });

  const secondCard = parsed.cards[1];
  assert.equal(secondCard.title, 'Tumble Tots 1 & 2 years');
  assert.equal(secondCard.dateText, '23 Nov 2026');
  assert.equal(secondCard.address, 'Addie Mills Centre, 2 Astley Street, Gosnells 6110');
  assert.deepEqual(secondCard.tags, ['Event', 'Childrens Program']);
  assert.equal(secondCard.coordinates, undefined);

  const requestedUrls = [];
  const crawler = createOpenCitiesHtmlCrawler(config, {
    now: TEST_NOW,
    pageDelayMs: 0,
    detailDelayMs: 0,
    fetchFn: async (url) => {
      requestedUrls.push(url);
      return { ok: true, async text() { return html; } };
    }
  });

  const listings = await crawler.fetchListings();
  assert.deepEqual(requestedUrls, ['https://example.wa.gov.au/Events-Directory']);
  assert.equal(listings.length, 2);

  assert.equal(listings[0].source, 'test_opencities');
  assert.equal(listings[0].source_id, 'oc-101');
  assert.equal(listings[0].category, 'sports');
  assert.equal(listings[0].organizer.name, 'Gosnells Netball Association');
  assert.deepEqual(listings[0].coordinates, { lat: -32.0795, lng: 115.9975 });
  assert.equal(listings[0].cost_description, '$5');
  assert.equal(listings[0].is_free, false);

  assert.equal(listings[1].category, 'family');
  assert.equal(listings[1].organizer.name, 'Test Council');
  assert.equal(listings[1].coordinates, undefined);
  assert.equal(listings[1].display_price, '');
  assert.equal(listings[1].is_free, false);

  const sanitized = sanitizeActivity(listings[0]);
  assert.equal(sanitized.id, 'test_opencities_oc-101');
  assert.equal(sanitized.schedule.start_date, '2026-11-20');
  assert.equal(sanitized.schedule.start_time, '18:00');
});

test('Slice 2: selectively hydrates detail pages when required fields are missing, normalizes shorthand time ranges, and skips civic/online pre-hydration', async () => {
  assert.equal(DEFAULT_DETAIL_DELAY_MS, 250);
  assert.equal(normalizeTimeRangeText('4 - 8pm'), '4pm - 8pm');
  assert.equal(normalizeTimeRangeText('10:00 - 11:00am'), '10:00am - 11:00am');
  assert.equal(normalizeTimeRangeText('11:00 - 2:00pm'), '11:00am - 2:00pm');
  assert.equal(normalizeTimeRangeText('12:00 - 2:00pm'), '12:00pm - 2:00pm');
  assert.equal(normalizeTimeRangeText('9 - 12pm'), '9am - 12pm');
  assert.equal(normalizeTimeRangeText('4pm - 8pm'), '4pm - 8pm');

  const detailHtml = `<!DOCTYPE html><html><body>
    <div class="event-content">
      <h2 class="event-title">Street Dance &amp; Hip Hop Jam</h2>
      <article class="event-description"><p>Open floor street dance battle.</p></article>
    </div>
    <div class="event-detail-panel">
      <div class="location-info">
        <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-clock event-icon"></i></span>4 - 8pm</p>
        <p class="detail-label-container"><span class="detail-label"><i class="far fa-calendar-alt event-icon"></i></span>Saturday 28 November 2026</p>
        <p class="detail-label-container"><span class="detail-label"><span><i class="fa-solid fa-location-dot event-icon"></i></span></span>Leederville Skate Park, Oxford Street</p>
        <p class="hidden"><span class="detail-label"><span id="lblVenue">Venue:</span></span>Leederville Skate Bowl</p>
        <p class="detail-label-container"><span class="detail-label"><i class="fas fa-usd-circle event-icon"></i></span>$10</p>
        <p class="events-detail-category"><span class="detail-label">Category: </span>Dance, Youth</p>
      </div>
      <div class="contact-info">
        <p class="hidden"><span class="detail-label hidden"><i class="fa-thin fa-phone event-icon"></i></span>The Spot Dance Studio</p>
        <p><span class="detail-label">Email: </span><a href="/cdn-cgi/l/email-protection#abc">[email&#160;protected]</a></p>
        <p><span class="detail-label">Website: </span><a href="https://thespotperth.com/">https://thespotperth.com/</a></p>
      </div>
    </div>
  </body></html>`;

  const parsedDetail = parseOpenCitiesDetailPage(detailHtml, { baseUrl: 'https://example.wa.gov.au' });
  assert.equal(parsedDetail.title, 'Street Dance & Hip Hop Jam');
  assert.equal(parsedDetail.description, 'Open floor street dance battle.');
  assert.equal(parsedDetail.timeText, '4 - 8pm');
  assert.equal(parsedDetail.dateText, 'Saturday 28 November 2026');
  assert.equal(parsedDetail.address, 'Leederville Skate Park, Oxford Street');
  assert.equal(parsedDetail.venueName, 'Leederville Skate Bowl');
  assert.equal(parsedDetail.cost, '$10');
  assert.deepEqual(parsedDetail.tags, ['Dance', 'Youth']);
  assert.deepEqual(parsedDetail.organizer, {
    name: 'The Spot Dance Studio',
    website: 'https://thespotperth.com/'
  });

  const listingHtml = `<!DOCTYPE html><html><body>
    <a href="/events/complete-card/101"><article>
      <strong class="date">22 November 2026</strong>
      <h3 class="title">Complete Listing Card</h3>
      <strong class="location">Beatty Park, North Perth</strong>
    </article></a>
    <a href="/events/street-dance-jam/102"><article>
      <span class="date"><strong>Sat 28 Nov</strong></span>
      <h3 class="title">Street Dance &amp; Hip Hop Jam</h3>
    </article></a>
    <a href="/events/ordinary-council-meeting/103"><article>
      <span class="date"><strong>Tue 24 Nov</strong></span>
      <h3 class="title">Ordinary Council Meeting</h3>
    </article></a>
    <a href="/events/missing-detail-card/104"><article>
      <strong class="date">29 November 2026</strong>
      <h3 class="title">Community Park Picnic</h3>
    </article></a>
  </body></html>`;

  const fetchedUrls = [];
  const delays = [];
  const crawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_council',
      label: 'Test Council',
      endpoint: 'https://example.wa.gov.au/events/',
      baseUrl: 'https://example.wa.gov.au',
      defaultOrganizer: { id: 'org_test', name: 'Test Council', website: 'https://example.wa.gov.au' }
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      detailDelayMs: 250,
      delayFn: async (ms) => { delays.push(ms); },
      fetchFn: async (url) => {
        fetchedUrls.push(url);
        if (url === 'https://example.wa.gov.au/events/') {
          return { ok: true, async text() { return listingHtml; } };
        }
        if (url === 'https://example.wa.gov.au/events/street-dance-jam/102') {
          return { ok: true, async text() { return detailHtml; } };
        }
        if (url === 'https://example.wa.gov.au/events/missing-detail-card/104') {
          return { ok: false, status: 404, statusText: 'Not Found' };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    }
  );

  const listings = await crawler.fetchListings();
  assert.deepEqual(fetchedUrls, [
    'https://example.wa.gov.au/events/',
    'https://example.wa.gov.au/events/street-dance-jam/102',
    'https://example.wa.gov.au/events/missing-detail-card/104'
  ]);
  assert.deepEqual(delays, [250, 250]);
  assert.equal(listings.length, 3);

  const hydrated = listings.find(item => item.source_id === '102');
  assert.ok(hydrated);
  assert.equal(hydrated.category, 'arts');
  assert.equal(hydrated.venue_name, 'Leederville Skate Bowl');
  assert.equal(hydrated.address, 'Leederville Skate Park, Oxford Street');
  assert.equal(hydrated.organizer.name, 'The Spot Dance Studio');
  assert.equal(hydrated.organizer.website, 'https://thespotperth.com/');
  const sanitizedHydrated = sanitizeActivity({ ...hydrated, coordinates: { lat: -31.9366, lng: 115.8431 } });
  assert.equal(sanitizedHydrated.schedule.start_date, '2026-11-28');
  assert.equal(sanitizedHydrated.schedule.start_time, '16:00');
  assert.equal(sanitizedHydrated.schedule.end_time, '20:00');

  // Fallback card retains listing fields cleanly when detail fetch returns 404
  const fallbackCard = listings.find(item => item.source_id === '104');
  assert.ok(fallbackCard);
  assert.equal(fallbackCard.title, 'Community Park Picnic');
  assert.equal(fallbackCard.organizer.name, 'Test Council');
});

test('Slice 3: paginates across GET rel=next, Seamless POST, and Telerik RadDataPager POST with caps and duplicate-page stop', async () => {
  const makeCardHtml = (id, title = `Community Yoga ${id}`) => `
    <article data-event-id="${id}">
      <h2 class="list-item-title"><a href="/events/${id}">${title}</a></h2>
      <div class="event-dates"><time datetime="2026-11-20T09:00:00+08:00">20 Nov 2026</time></div>
      <div class="location-info">Civic Park, Perth</div>
      <div class="event-categories">Health</div>
    </article>`;

  // 1. Anchor GET rel="next" with 25 pages * 12 items = 300 -> stops at 200 items / 17 pages (16 delays of 1200ms)
  const getDelays = [];
  const getPages = [];
  const getCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_get',
      label: 'Test GET',
      endpoint: 'https://example.wa.gov.au/events',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 1200,
      delayFn: async (ms) => { getDelays.push(ms); },
      fetchFn: async (url) => {
        const page = Number(new URL(url).searchParams.get('page') || '1');
        getPages.push(page);
        const start = (page - 1) * 12 + 1;
        const cards = Array.from({ length: 12 }, (_, idx) => makeCardHtml(`g-${start + idx}`)).join('\n');
        const nextLink = page < 25 ? `<a rel="next" href="/events?page=${page + 1}">Next</a>` : '';
        return { ok: true, async text() { return `<html><body>${cards}${nextLink}</body></html>`; } };
      }
    }
  );
  const getItems = await getCrawler.fetchListings();
  assert.equal(getItems.length, 200);
  assert.equal(getPages.length, 17);
  assert.equal(getDelays.length, 16);
  assert.ok(getDelays.every(d => d === 1200));

  // 2. 20-page cap when items per page are fewer (25 pages * 5 items -> stops at 20 pages = 100 items)
  const pageCapUrls = [];
  const pageCapCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_cap20',
      label: 'Test Cap 20',
      endpoint: 'https://example.wa.gov.au/events',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (url) => {
        pageCapUrls.push(url);
        const page = Number(new URL(url).searchParams.get('page') || '1');
        const start = (page - 1) * 5 + 1;
        const cards = Array.from({ length: 5 }, (_, idx) => makeCardHtml(`c-${start + idx}`)).join('\n');
        return {
          ok: true,
          async text() {
            return `<html><body>${cards}<nav class="pagination"><a class="next" href="?page=${page + 1}">Next</a></nav></body></html>`;
          }
        };
      }
    }
  );
  const pageCapItems = await pageCapCrawler.fetchListings();
  assert.equal(pageCapUrls.length, 20);
  assert.equal(pageCapItems.length, 100);

  // 3. OpenCities Seamless ASP.NET form POST pagination
  const seamlessRequests = [];
  const seamlessCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_seamless',
      label: 'Test Seamless',
      endpoint: 'https://example.wa.gov.au/Events-Directory',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (url, init) => {
        seamlessRequests.push({ url, method: init.method, body: init.body });
        if (init.method === 'GET') {
          return {
            ok: true,
            async text() {
              return `<html><body>
                <form name="mainForm" method="post" action="/Events-Directory" id="mainForm">
                  <input type="hidden" name="__EVENTTARGET" value="" />
                  <input type="hidden" name="__EVENTARGUMENT" value="" />
                  <input type="hidden" name="__SEAMLESSVIEWSTATE" value="TOKEN_1" />
                  <input type="hidden" name="__VIEWSTATE" value="" />
                  ${makeCardHtml('s-1')}
                  <span class="button-next"><input type="submit" name="ctl09$ctl00$ctl09" value="Next" class="btn_scPagingNonJS_enabled" /></span>
                </form>
              </body></html>`;
            }
          };
        }
        return {
          ok: true,
          async text() {
            return `<html><body>
              <form name="mainForm" method="post" action="/Events-Directory" id="mainForm">
                <input type="hidden" name="__SEAMLESSVIEWSTATE" value="TOKEN_2" />
                ${makeCardHtml('s-2')}
                <span class="button-next"><input type="submit" name="ctl09$ctl00$ctl09" value="Next" disabled="disabled" class="btn_scPagingNonJS_disabled" /></span>
              </form>
            </body></html>`;
          }
        };
      }
    }
  );
  const seamlessItems = await seamlessCrawler.fetchListings();
  assert.equal(seamlessRequests.length, 2);
  assert.equal(seamlessRequests[1].method, 'POST');
  const seamlessParams = new URLSearchParams(seamlessRequests[1].body);
  assert.equal(seamlessParams.get('__SEAMLESSVIEWSTATE'), 'TOKEN_1');
  assert.equal(seamlessParams.get('ctl09$ctl00$ctl09'), 'Next');
  assert.deepEqual(seamlessItems.map(i => i.source_id), ['s-1', 's-2']);

  // 4. Telerik RadDataPager ASP.NET __doPostBack POST pagination + duplicate-page guard
  const telerikRequests = [];
  const telerikCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_telerik',
      label: 'Test Telerik',
      endpoint: 'https://example.wa.gov.au/events/',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (url, init) => {
        telerikRequests.push({ url, method: init.method, body: init.body });
        if (init.method === 'GET') {
          return {
            ok: true,
            async text() {
              return `<html><body>
                <form method="post" action="/events/" id="form1">
                  <input type="hidden" name="__VIEWSTATE" value="VS_1" />
                  <input type="hidden" name="__VIEWSTATEGENERATOR" value="GEN_1" />
                  ${makeCardHtml('t-1')}
                  <div class="RadDataPager">
                    <button type="button" name="ctl00$Grid$NextButton" onclick="javascript:__doPostBack(&#39;ctl00$Grid$NextButton&#39;,&#39;&#39;)" class="rdpActionButton rdpPageNext"></button>
                  </div>
                </form>
              </body></html>`;
            }
          };
        }
        return {
          ok: true,
          async text() {
            return `<html><body>
              <form method="post" action="/events/" id="form1">
                <input type="hidden" name="__VIEWSTATE" value="VS_2" />
                ${makeCardHtml('t-2')}
                <div class="RadDataPager">
                  <button type="button" name="ctl00$Grid$NextButton" onclick="return false;__doPostBack(&#39;ctl00$Grid$NextButton&#39;,&#39;&#39;)" class="rdpActionButton rdpPageNext"></button>
                </div>
              </form>
            </body></html>`;
          }
        };
      }
    }
  );
  const telerikItems = await telerikCrawler.fetchListings();
  assert.equal(telerikRequests.length, 2);
  assert.equal(telerikRequests[1].method, 'POST');
  const telerikParams = new URLSearchParams(telerikRequests[1].body);
  assert.equal(telerikParams.get('__EVENTTARGET'), 'ctl00$Grid$NextButton');
  assert.equal(telerikParams.get('__VIEWSTATE'), 'VS_1');
  assert.equal(telerikParams.get('__VIEWSTATEGENERATOR'), 'GEN_1');
  assert.deepEqual(telerikItems.map(i => i.source_id), ['t-1', 't-2']);

  // 5. Duplicate-only page terminates pagination early
  let dupCalls = 0;
  const dupCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_dup',
      label: 'Test Dup',
      endpoint: 'https://example.wa.gov.au/events',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => {
        dupCalls += 1;
        return {
          ok: true,
          async text() {
            return `<html><body>${makeCardHtml('dup-1')}<a rel="next" href="/events?page=${dupCalls + 1}">Next</a></body></html>`;
          }
        };
      }
    }
  );
  const dupItems = await dupCrawler.fetchListings();
  assert.equal(dupCalls, 2);
  assert.equal(dupItems.length, 1);
});

test('Slice 4: filters noise/online/expired/horizon items, maps all 9 canonical categories, and supports explicit vs null fallback Organizer', async () => {
  const html = `<!DOCTYPE html><html><body>
    <article data-event-id="drop-civic">
      <h2 class="list-item-title"><a href="/events/council-meeting">Ordinary Council Meeting</a></h2>
      <div class="event-dates"><time datetime="2026-11-18T18:00:00+08:00">18 Nov 2026</time></div>
      <div class="location-info">Council Chambers</div>
    </article>
    <article data-event-id="drop-online">
      <h2 class="list-item-title"><a href="/events/webinar">Small Business Webinar (Online Only)</a></h2>
      <div class="event-dates"><time datetime="2026-11-19T12:00:00+08:00">19 Nov 2026</time></div>
      <div class="location-info">Zoom</div>
    </article>
    <article data-event-id="drop-expired">
      <h2 class="list-item-title"><a href="/events/past-yoga">October Park Yoga</a></h2>
      <div class="event-dates"><time datetime="2026-10-15T09:00:00+08:00">15 Oct 2026</time></div>
      <div class="location-info">Hyde Park</div>
      <div class="event-categories">Health</div>
    </article>
    <article data-event-id="drop-horizon">
      <h2 class="list-item-title"><a href="/events/far-future">Autumn 2027 Gala</a></h2>
      <div class="event-dates"><time datetime="2027-04-01T10:00:00+08:00">1 Apr 2027</time></div>
      <div class="location-info">Hyde Park</div>
      <div class="event-categories">Music</div>
    </article>
    <article data-event-id="keep-sports">
      <h2 class="list-item-title"><a href="/events/tennis">Social Tennis</a></h2>
      <div class="event-dates">20 Nov 2026</div>
      <div class="location-info">Robertson Park</div>
      <div class="event-categories">Sport</div>
      <div class="event-organizer">Robertson Park Tennis Club</div>
    </article>
    <article data-event-id="keep-health">
      <h2 class="list-item-title"><a href="/events/yoga">Park Yoga</a></h2>
      <div class="event-dates">21 Nov 2026</div>
      <div class="location-info">Hyde Park</div>
      <div class="event-categories">Health &amp; Wellbeing</div>
    </article>
    <article data-event-id="keep-arts">
      <h2 class="list-item-title"><a href="/events/gallery">Laneway Art Show</a></h2>
      <div class="event-dates">22 Nov 2026</div>
      <div class="location-info">Leederville</div>
      <div class="event-categories">Arts &amp; Culture</div>
    </article>
    <article data-event-id="keep-music">
      <h2 class="list-item-title"><a href="/events/jazz">Twilight Jazz</a></h2>
      <div class="event-dates">23 Nov 2026</div>
      <div class="location-info">Beatty Park</div>
      <div class="event-categories">Music &amp; Concerts</div>
    </article>
    <article data-event-id="keep-community">
      <h2 class="list-item-title"><a href="/events/seniors">Seniors Morning Tea</a></h2>
      <div class="event-dates">24 Nov 2026</div>
      <div class="location-info">Library</div>
      <div class="event-categories">Seniors</div>
    </article>
    <article data-event-id="keep-family">
      <h2 class="list-item-title"><a href="/events/story">Toddler Storytime</a></h2>
      <div class="event-dates">25 Nov 2026</div>
      <div class="location-info">Library</div>
      <div class="event-categories">Childrens Program</div>
    </article>
    <article data-event-id="keep-food">
      <h2 class="list-item-title"><a href="/events/market">Farmers Market</a></h2>
      <div class="event-dates">26 Nov 2026</div>
      <div class="location-info">Kyilla Park</div>
      <div class="event-categories">Food &amp; Markets</div>
    </article>
    <article data-event-id="keep-hobbies">
      <h2 class="list-item-title"><a href="/events/craft">Social Craft Workshop</a></h2>
      <div class="event-dates">27 Nov 2026</div>
      <div class="location-info">Community Hall</div>
      <div class="event-categories">Craft &amp; Hobbies</div>
    </article>
    <article data-event-id="keep-travel">
      <h2 class="list-item-title"><a href="/events/walk">Heritage Bushwalk Tour</a></h2>
      <div class="event-dates">28 Nov 2026</div>
      <div class="location-info">Bold Park</div>
      <div class="event-categories">Nature &amp; Guided Walk</div>
    </article>
  </body></html>`;

  const crawlerNoFallback = createOpenCitiesHtmlCrawler(
    {
      source: 'test_agg',
      label: 'Test Aggregator',
      endpoint: 'https://example.wa.gov.au/events',
      baseUrl: 'https://example.wa.gov.au',
      defaultOrganizer: null
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: true, async text() { return html; } })
    }
  );

  const items = await crawlerNoFallback.fetchListings();
  assert.equal(items.length, 9);
  assert.deepEqual(
    items.map(i => i.category),
    ['sports', 'health', 'arts', 'music', 'community', 'family', 'food', 'hobbies', 'travel']
  );
  assert.equal(items[0].organizer.name, 'Robertson Park Tennis Club');
  assert.equal(items[1].organizer, undefined);
});

test('Slice 5: throws descriptive errors on missing config or HTTP failure and avoids double-decoding entities', async () => {
  assert.throws(
    () => createOpenCitiesHtmlCrawler({ source: 'missing_endpoint' }),
    /requires source, endpoint, and baseUrl/
  );

  const failingCrawler = createOpenCitiesHtmlCrawler(
    {
      source: 'vincent',
      label: 'City of Vincent',
      endpoint: 'https://www.vincent.wa.gov.au/events/',
      baseUrl: 'https://www.vincent.wa.gov.au'
    },
    {
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
    }
  );
  await assert.rejects(() => failingCrawler.fetchListings(), /City of Vincent responded with HTTP 503/);

  const encodedHtml = `<article data-event-id="enc-1">
    <h2 class="list-item-title"><a href="/events/1">A &amp;lt; B &amp; C &#x2013; Workshop</a></h2>
    <div class="event-dates">20 Nov 2026</div>
    <div class="location-info">Leederville</div>
  </article>`;
  const parsed = parseOpenCitiesListingPage(encodedHtml, { baseUrl: 'https://example.wa.gov.au' });
  assert.equal(parsed.cards[0].title, 'A &lt; B & C – Workshop');
});

test('Regression: exact CSS class token matching prevents .location-info from matching .location and prefers year-bearing dates on duplicate merge', () => {
  const detailOnlyClockAndDate = `<div class="event-detail-panel">
    <div class="location-info">
      <p class="detail-label-container"><span class="detail-label"><i class="fa-solid fa-clock event-icon"></i></span>10-11am</p>
      <p class="detail-label-container"><span class="detail-label"><i class="far fa-calendar-alt event-icon"></i></span>Saturday 21 November - Tuesday 8 December 2026</p>
    </div>
  </div>`;
  const parsedDetail = parseOpenCitiesDetailPage(detailOnlyClockAndDate, { baseUrl: 'https://example.wa.gov.au' });
  assert.equal(parsedDetail.location, undefined);
  assert.equal(parsedDetail.venueName, undefined);
  assert.equal(parsedDetail.address, undefined);
  assert.equal(parsedDetail.dateText, 'Saturday 21 November - Tuesday 8 December 2026');

  const duplicateCardsHtml = `<div>
    <a href="/events/pride/3774"><article>
      <span class="date"><strong>Sun 1 Nov - Fri 27 Nov</strong></span>
      <h3 class="title">November is PRIDE month</h3>
    </article></a>
    <a href="/events/pride/3774"><article>
      <strong class="date">27 November 2026</strong>
      <h3 class="title">November is PRIDE month</h3>
      <strong class="location">Various locations</strong>
    </article></a>
  </div>`;
  const parsedCards = parseOpenCitiesListingPage(duplicateCardsHtml, { baseUrl: 'https://example.wa.gov.au' });
  assert.equal(parsedCards.cards.length, 1);
  assert.equal(parsedCards.cards[0].dateText, '27 November 2026');
  assert.equal(parsedCards.cards[0].location, 'Various locations');
});

test('Regression: preserves .event-time with date-only <time> and selects enclosing events <form> over preceding header search <form>', async () => {
  const html = `<!DOCTYPE html><html><body>
    <header>
      <form action="/site-search" method="get">
        <input type="text" name="q" />
      </form>
    </header>
    <form method="post" action="/Events-Directory" id="eventsForm">
      <input type="hidden" name="__SEAMLESSVIEWSTATE" value="EVENTS_TOKEN" />
      <article data-event-id="time-date-only">
        <h2 class="list-item-title"><a href="/events/morning-yoga">Morning Yoga</a></h2>
        <div class="event-dates">
          <time datetime="2026-11-20">20 Nov 2026</time>
          <span class="event-time">7:00am - 8:00am</span>
        </div>
        <div class="location-info">Hyde Park</div>
      </article>
      <article data-event-id="time-start-iso">
        <h2 class="list-item-title"><a href="/events/evening-jazz">Evening Jazz</a></h2>
        <div class="event-dates">
          <time datetime="2026-11-21T18:00:00+08:00">21 Nov 2026</time>
          <span class="event-time">6:00pm - 8:30pm</span>
        </div>
        <div class="location-info">Hyde Park</div>
      </article>
      <span class="button-next"><input type="submit" name="ctl09$Next" value="Next" class="btn_scPagingNonJS_enabled" /></span>
    </form>
  </body></html>`;

  const parsed = parseOpenCitiesListingPage(html, {
    baseUrl: 'https://example.wa.gov.au',
    currentUrl: 'https://example.wa.gov.au/Events-Directory'
  });
  assert.equal(parsed.hasMore, true);
  assert.equal(parsed.nextRequest.method, 'POST');
  assert.equal(parsed.nextRequest.url, 'https://example.wa.gov.au/Events-Directory');
  assert.equal(parsed.nextRequest.formBody.get('__SEAMLESSVIEWSTATE'), 'EVENTS_TOKEN');

  const crawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_time_form',
      label: 'Test Time Form',
      endpoint: 'https://example.wa.gov.au/Events-Directory',
      baseUrl: 'https://example.wa.gov.au'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async (_url, init) => {
        if (init.method === 'GET') {
          return { ok: true, async text() { return html; } };
        }
        return { ok: true, async text() { return '<html><body></body></html>'; } };
      }
    }
  );

  const items = await crawler.fetchListings();
  assert.equal(items.length, 2);

  const first = sanitizeActivity({ ...items[0], coordinates: { lat: -31.94, lng: 115.86 } });
  assert.equal(first.schedule.start_date, '2026-11-20');
  assert.equal(first.schedule.start_time, '07:00');
  assert.equal(first.schedule.end_time, '08:00');

  const second = sanitizeActivity({ ...items[1], coordinates: { lat: -31.94, lng: 115.86 } });
  assert.equal(second.schedule.start_date, '2026-11-21');
  assert.equal(second.schedule.start_time, '18:00');
  assert.equal(second.schedule.end_time, '20:30');
});

test('OpenCities HTML adapter emits empty cost when upstream cost and Free/Ticketed tags are absent', async () => {
  const html = `<!DOCTYPE html><html><body>
    <section class="oc-events-listing">
      <article data-event-id="oc-unknown">
        <h2 class="list-item-title"><a href="/events/unknown-cost">Community Yoga Session</a></h2>
        <div class="event-dates"><time datetime="2026-11-20T09:00:00+08:00">20 Nov 2026</time></div>
        <div class="location-info">Civic Park</div>
        <div class="event-categories">Health</div>
      </article>
      <article data-event-id="oc-free">
        <h2 class="list-item-title"><a href="/events/free-tag">Free Walking Group</a></h2>
        <div class="event-dates"><time datetime="2026-11-21T09:00:00+08:00">21 Nov 2026</time></div>
        <div class="location-info">Civic Park</div>
        <div class="event-categories">Free</div>
      </article>
      <article data-event-id="oc-paid">
        <h2 class="list-item-title"><a href="/events/paid-cost">Pottery Class</a></h2>
        <div class="event-dates"><time datetime="2026-11-22T09:00:00+08:00">22 Nov 2026</time></div>
        <div class="location-info">Arts Hub</div>
        <div class="event-cost">$15</div>
      </article>
    </section>
  </body></html>`;

  const crawler = createOpenCitiesHtmlCrawler(
    {
      source: 'test_opencities_cost',
      label: 'Test OpenCities Cost',
      endpoint: 'https://example.wa.gov.au/Events-Directory',
      baseUrl: 'https://example.wa.gov.au',
      hydrateDetail: 'never'
    },
    {
      now: TEST_NOW,
      pageDelayMs: 0,
      fetchFn: async () => ({ ok: true, async text() { return html; } })
    }
  );

  const items = await crawler.fetchListings();
  assert.equal(items.length, 3);

  const unknown = items.find(i => i.source_id === 'oc-unknown');
  assert.equal(unknown.display_price, '');
  assert.equal(unknown.cost_description, '');
  assert.equal(unknown.is_free, false);

  const free = items.find(i => i.source_id === 'oc-free');
  assert.equal(free.display_price, 'Free');
  assert.equal(free.is_free, true);

  const paid = items.find(i => i.source_id === 'oc-paid');
  assert.equal(paid.display_price, '$15');
  assert.equal(paid.is_free, false);
});



