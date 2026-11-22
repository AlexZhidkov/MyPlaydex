/**
 * Town of Cambridge Activities Crawler
 * Configured on top of the shared OpenCities HTML council adapter.
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const CAMBRIDGE_ENDPOINT = 'https://www.cambridge.wa.gov.au/Discover/Whats-On';
export const CAMBRIDGE_BASE_URL = 'https://www.cambridge.wa.gov.au';
export const CAMBRIDGE_LGA_CENTROID = Object.freeze({ lat: -31.9392, lng: 115.8097 });

export const CAMBRIDGE_CONFIG = {
  source: 'cambridge',
  label: 'Town of Cambridge',
  group: 'councils',
  endpoint: CAMBRIDGE_ENDPOINT,
  baseUrl: CAMBRIDGE_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: CAMBRIDGE_LGA_CENTROID,
  minExpectedListings: 1,
  cardUrlPattern: /\/Discover\/Whats-On\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_town_of_cambridge',
    name: 'Town of Cambridge',
    website: CAMBRIDGE_BASE_URL
  }
};

/**
 * Creates a Town of Cambridge crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createCambridgeCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(CAMBRIDGE_CONFIG, options);
}
