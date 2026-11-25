/**
 * City of Nedlands Activities Crawler
 * Configured on top of the shared OpenCities / semantic HTML council adapter.
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const NEDLANDS_ENDPOINT = 'https://www.nedlands.wa.gov.au/events/';
export const NEDLANDS_BASE_URL = 'https://www.nedlands.wa.gov.au';
export const NEDLANDS_LGA_CENTROID = Object.freeze({ lat: -31.9808, lng: 115.8093 });

export const NEDLANDS_CONFIG = {
  source: 'nedlands',
  label: 'City of Nedlands',
  group: 'councils',
  endpoint: NEDLANDS_ENDPOINT,
  baseUrl: NEDLANDS_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: NEDLANDS_LGA_CENTROID,
  minExpectedListings: 1,
  cardUrlPattern: /\/events\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_city_of_nedlands',
    name: 'City of Nedlands',
    website: NEDLANDS_BASE_URL
  }
};

/**
 * Creates a City of Nedlands crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createNedlandsCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(NEDLANDS_CONFIG, options);
}
