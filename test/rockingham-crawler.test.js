import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRockinghamCrawler,
  ROCKINGHAM_CONFIG,
  ROCKINGHAM_LGA_CENTROID
} from '../src/crawlers/rockingham-crawler.js';
import { sanitizeActivity } from '../src/sanitizer.js';
import { applyVenueResolution, resolveActivityVenueAndCoordinates } from '../src/venue-resolver.js';
import { getDefaultCrawlers } from '../src/crawler-runner.js';

const TEST_NOW = new Date('2026-11-20T08:00:00+08:00');

const ROCKINGHAM_FIXTURE_PAGE_1 = {
  Total: 4,
  Data: [
    {
      ArticleReleaseDate: '2026-11-25T00:00:00',
      ArticleReleaseDateString: '25 November 2026',
      ArticleTeaser: '/getContentAsset/836629f4-a8c9-44c3-a659-5379cff7e0e7/STEAM-Lab.webp?language=en',
      Categories: ['City presented', 'Young People'],
      Topics: ['Children', 'Youth'],
      Suburbs: ['Baldivis'],
      Venues: ['Mary Davies Library and Community Centre'],
      index: 0,
      ArticleTitle: 'STEAM Lab - Baldivis',
      ArticleSummary: 'Challenge your creativity and problem-solving skills through hands-on collaborative workshops.',
      PageUrl: '/events,-culture-and-tourism/events/what-s-on-calendar/steam-lab'
    },
    {
      ArticleReleaseDate: '2026-11-29T09:00:00',
      ArticleReleaseDateString: '29 November 2026',
      ArticleTeaser: '/getContentAsset/abc/beach-volleyball.webp?language=en',
      Categories: ['Sports & Recreation'],
      Venues: ['Rockingham Foreshore'],
      index: 1,
      ArticleTitle: 'Rockingham Foreshore Social Volleyball',
      ArticleSummary: 'Free community beach volleyball session.',
      PageUrl: '/events,-culture-and-tourism/events/what-s-on-calendar/foreshore-social-volleyball'
    },
    {
      ArticleReleaseDate: '2026-11-24T18:00:00',
      ArticleReleaseDateString: '24 November 2026',
      ArticleTeaser: '/getContentAsset/def/council-meeting.webp?language=en',
      Categories: ['Council'],
      Venues: ['Rockingham Civic Centre'],
      index: 2,
      ArticleTitle: 'Ordinary Council Meeting',
      ArticleSummary: 'Monthly council meeting.',
      PageUrl: '/events,-culture-and-tourism/events/what-s-on-calendar/ordinary-council-meeting'
    },
    {
      ArticleReleaseDate: '2026-11-26T10:00:00',
      ArticleReleaseDateString: '26 November 2026',
      ArticleTeaser: '/getContentAsset/ghi/webinar.webp?language=en',
      Categories: ['Community'],
      Venues: ['Online'],
      index: 3,
      ArticleTitle: 'Small Business Sustainability Webinar',
      ArticleSummary: 'Online workshop.',
      PageUrl: '/events,-culture-and-tourism/events/what-s-on-calendar/small-business-webinar'
    }
  ]
};

test('Rockingham crawler parses Kentico/Kendo payload, maps categories and venues, and filters civic/online noise', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return ROCKINGHAM_FIXTURE_PAGE_1;
    }
  });

  const crawler = createRockinghamCrawler({ fetchFn: mockFetch, pageDelayMs: 0, now: TEST_NOW });
  assert.equal(crawler.name, 'rockingham');
  assert.equal(crawler.group, 'councils');
  assert.deepEqual(crawler.fallbackCentroid, ROCKINGHAM_LGA_CENTROID);

  const listings = await crawler.fetchListings();
  assert.equal(listings.length, 2);

  const [steamLab, volleyball] = listings;
  assert.equal(steamLab.source, 'rockingham');
  assert.equal(steamLab.source_id, 'steam_lab');
  assert.equal(steamLab.title, 'STEAM Lab - Baldivis');
  assert.equal(steamLab.description, 'Challenge your creativity and problem-solving skills through hands-on collaborative workshops.');
  assert.equal(steamLab.venue_name, 'Mary Davies Library and Community Centre');
  assert.equal(
    steamLab.source_url,
    'https://rockingham.wa.gov.au/events,-culture-and-tourism/events/what-s-on-calendar/steam-lab'
  );
  assert.equal(steamLab.organizer.name, 'City of Rockingham');

  const resolution = resolveActivityVenueAndCoordinates(steamLab, {
    fallbackCentroid: ROCKINGHAM_LGA_CENTROID
  });
  const resolvedSteam = applyVenueResolution(
    { ...steamLab, venue: { ...steamLab.venue, coordinates: resolution.coordinates } },
    resolution
  );
  const sanitizedSteam = sanitizeActivity(resolvedSteam);
  assert.equal(sanitizedSteam.id, 'rockingham_steam_lab');
  assert.equal(sanitizedSteam.schedule.start_date, '2026-11-25');
  assert.equal(sanitizedSteam.organizer.id, 'org_city_of_rockingham');
  assert.deepEqual(sanitizedSteam.venue.coordinates, ROCKINGHAM_LGA_CENTROID);

  assert.equal(volleyball.category, 'sports');
  assert.equal(volleyball.subcategory, 'other');
  assert.equal(volleyball.venue_name, 'Rockingham Foreshore');
});

test('getDefaultCrawlers registers rockingham under councils group', () => {
  const defaults = getDefaultCrawlers();
  const rockingham = defaults.find(c => c.name === 'rockingham');
  assert.ok(rockingham, 'rockingham should be registered in getDefaultCrawlers()');
  assert.equal(rockingham.group, 'councils');
  assert.deepEqual(rockingham.fallbackCentroid, ROCKINGHAM_LGA_CENTROID);
  assert.equal(ROCKINGHAM_CONFIG.minExpectedListings, 1);
});
