/**
 * City of Stirling Activities Crawler
 * Configured on top of the shared Kentico/Kendo UI council adapter.
 */

import { createKenticoKendoCrawler } from './kentico-kendo-adapter.js';

export const STIRLING_ENDPOINT = 'https://www.stirling.wa.gov.au/ksearchevent/ksearchresult';
export const STIRLING_BASE_URL = 'https://www.stirling.wa.gov.au';
export const STIRLING_LGA_CENTROID = Object.freeze({ lat: -31.8847, lng: 115.8079 });

export const STIRLING_CONFIG = {
  source: 'stirling',
  label: 'Stirling',
  group: 'councils',
  endpoint: STIRLING_ENDPOINT,
  baseUrl: STIRLING_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: STIRLING_LGA_CENTROID,
  minExpectedListings: 1,
  searchParam: [
    { key: 'classname', values: ['AWPT.Event'], or: 'true', operator: 'eq' },
    { key: 'searchindexes', values: ['Events'], or: 'true', operator: 'eq' },
    { key: 'nodealiaspath', values: ['/'], or: 'true', operator: 'eq' },
    { key: 'FilterIsExpired', values: ['false'], or: 'true', operator: 'eq' }
  ],
  searchFilter: [],
  defaultOrganizer: {
    id: 'org_city_of_stirling',
    name: 'City of Stirling',
    website: STIRLING_BASE_URL
  }
};

/**
 * Creates a City of Stirling crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createStirlingCrawler(options = {}) {
  return createKenticoKendoCrawler(STIRLING_CONFIG, options);
}
