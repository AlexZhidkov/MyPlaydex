/**
 * City of Gosnells Activities Crawler
 * Configured on top of the shared OpenCities HTML council adapter.
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const GOSNELLS_ENDPOINT = 'https://www.gosnells.wa.gov.au/Events-Directory';
export const GOSNELLS_BASE_URL = 'https://www.gosnells.wa.gov.au';
export const GOSNELLS_LGA_CENTROID = Object.freeze({ lat: -32.0792, lng: 115.9972 });

export const GOSNELLS_CONFIG = {
  source: 'gosnells',
  label: 'City of Gosnells',
  group: 'councils',
  endpoint: GOSNELLS_ENDPOINT,
  baseUrl: GOSNELLS_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: GOSNELLS_LGA_CENTROID,
  minExpectedListings: 1,
  cardUrlPattern: /\/Events-Directory\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_city_of_gosnells',
    name: 'City of Gosnells',
    website: GOSNELLS_BASE_URL
  }
};

/**
 * Creates a City of Gosnells crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createGosnellsCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(GOSNELLS_CONFIG, options);
}
