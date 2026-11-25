/**
 * Town of Bassendean Activities Crawler
 * Configured on top of the shared OpenCities / semantic HTML council adapter.
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const BASSENDEAN_ENDPOINT = 'https://www.bassendean.wa.gov.au/events/';
export const BASSENDEAN_BASE_URL = 'https://www.bassendean.wa.gov.au';
export const BASSENDEAN_LGA_CENTROID = Object.freeze({ lat: -31.9042, lng: 115.9463 });

export const BASSENDEAN_CONFIG = {
  source: 'bassendean',
  label: 'Town of Bassendean',
  group: 'councils',
  endpoint: BASSENDEAN_ENDPOINT,
  baseUrl: BASSENDEAN_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: BASSENDEAN_LGA_CENTROID,
  minExpectedListings: 1,
  cardUrlPattern: /\/events\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_town_of_bassendean',
    name: 'Town of Bassendean',
    website: BASSENDEAN_BASE_URL
  }
};

/**
 * Creates a Town of Bassendean crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createBassendeanCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(BASSENDEAN_CONFIG, options);
}
