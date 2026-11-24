/**
 * City of Perth (Visit Perth) Activities Crawler
 * Configured on top of the shared Optimizely SSR JSON council adapter.
 * Acts as a tourism aggregator: preserves explicit organizers when present,
 * and leaves Organizer unset when unattributed (per ADR 0008 / ADR 0009).
 */

import { createOptimizelySsrCrawler } from './optimizely-ssr-adapter.js';

export const VISIT_PERTH_ENDPOINT = 'https://www.visitperth.com/events/';
export const VISIT_PERTH_BASE_URL = 'https://www.visitperth.com';
export const VISIT_PERTH_LGA_CENTROID = Object.freeze({ lat: -31.9505, lng: 115.8605 });

export const VISIT_PERTH_CONFIG = {
  source: 'visit_perth',
  label: 'Visit Perth',
  group: 'councils',
  endpoint: VISIT_PERTH_ENDPOINT,
  baseUrl: VISIT_PERTH_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: VISIT_PERTH_LGA_CENTROID,
  minExpectedListings: 1,
  defaultOrganizer: null,
  pageDelayMs: 5000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)'
};

/**
 * Creates a City of Perth (Visit Perth) crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createVisitPerthCrawler(options = {}) {
  return createOptimizelySsrCrawler(VISIT_PERTH_CONFIG, options);
}
