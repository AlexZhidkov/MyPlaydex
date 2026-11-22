/**
 * Town of Victoria Park Activities Crawler
 * Configured on top of the shared OpenCities / semantic HTML council adapter.
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const VICTORIA_PARK_ENDPOINT = 'https://www.victoriapark.wa.gov.au/events/';
export const VICTORIA_PARK_BASE_URL = 'https://www.victoriapark.wa.gov.au';
export const VICTORIA_PARK_LGA_CENTROID = Object.freeze({ lat: -31.9753, lng: 115.8978 });

export const VICTORIA_PARK_CONFIG = {
  source: 'victoria_park',
  label: 'Town of Victoria Park',
  group: 'councils',
  endpoint: VICTORIA_PARK_ENDPOINT,
  baseUrl: VICTORIA_PARK_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: VICTORIA_PARK_LGA_CENTROID,
  minExpectedListings: 1,
  cardUrlPattern: /\/events\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_town_of_victoria_park',
    name: 'Town of Victoria Park',
    website: VICTORIA_PARK_BASE_URL
  }
};

/**
 * Creates a Town of Victoria Park crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createVictoriaParkCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(VICTORIA_PARK_CONFIG, options);
}
