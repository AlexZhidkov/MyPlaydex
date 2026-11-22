/**
 * City of Vincent Activities Crawler
 * Configured on top of the shared OpenCities / semantic HTML council adapter.
 * Attributes City of Vincent as fallback Organizer when an explicit organizer is absent,
 * and configures minExpectedListings=0 for quiet weeks (per ADR 0009).
 */

import { createOpenCitiesHtmlCrawler } from './opencities-html-adapter.js';

export const VINCENT_ENDPOINT = 'https://www.vincent.wa.gov.au/events/';
export const VINCENT_BASE_URL = 'https://www.vincent.wa.gov.au';
export const VINCENT_LGA_CENTROID = Object.freeze({ lat: -31.9366, lng: 115.8431 });

export const VINCENT_CONFIG = {
  source: 'vincent',
  label: 'City of Vincent',
  group: 'councils',
  endpoint: VINCENT_ENDPOINT,
  baseUrl: VINCENT_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: VINCENT_LGA_CENTROID,
  minExpectedListings: 0,
  cardUrlPattern: /\/events\/[^/?#]+/i,
  defaultOrganizer: {
    id: 'org_city_of_vincent',
    name: 'City of Vincent',
    website: VINCENT_BASE_URL
  }
};

/**
 * Creates a City of Vincent crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createVincentCrawler(options = {}) {
  return createOpenCitiesHtmlCrawler(VINCENT_CONFIG, options);
}
