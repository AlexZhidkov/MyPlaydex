/**
 * City of Fremantle Activities Crawler
 * Configured on top of the shared AgencyWeb `aw_pagetypelisting` council adapter.
 */

import { createAwPageTypeListingCrawler } from './aw-pagetypelisting-adapter.js';

export const FREMANTLE_ENDPOINT = 'https://www.fremantle.wa.gov.au/wp-json/aw/v1/event';
export const FREMANTLE_BASE_URL = 'https://www.fremantle.wa.gov.au';
export const FREMANTLE_LGA_CENTROID = Object.freeze({ lat: -32.0569, lng: 115.7439 });

export const FREMANTLE_CONFIG = {
  source: 'fremantle',
  label: 'City of Fremantle',
  group: 'councils',
  endpoint: FREMANTLE_ENDPOINT,
  baseUrl: FREMANTLE_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: FREMANTLE_LGA_CENTROID,
  minExpectedListings: 1,
  pageSize: 50,
  postType: 'event',
  searchIndex: 'event',
  hydrateDetail: 'always',
  detailDelayMs: 300,
  defaultCost: 'See website',
  venueAliases: {
    Library: 'Fremantle Library'
  },
  venuePlaceholders: ['Other'],
  defaultOrganizer: {
    id: 'org_city_of_fremantle',
    name: 'City of Fremantle',
    website: FREMANTLE_BASE_URL
  }
};

/**
 * Creates a City of Fremantle crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createFremantleCrawler(options = {}) {
  return createAwPageTypeListingCrawler(FREMANTLE_CONFIG, options);
}
