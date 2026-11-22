/**
 * City of Wanneroo Activities Crawler
 * Configured on top of the shared Kentico/Kendo UI council adapter.
 */

import { createKenticoKendoCrawler } from './kentico-kendo-adapter.js';

export const WANNEROO_ENDPOINT = 'https://www.wanneroo.wa.gov.au/ksearch/eventresult';
export const WANNEROO_BASE_URL = 'https://www.wanneroo.wa.gov.au';
export const WANNEROO_LGA_CENTROID = Object.freeze({ lat: -31.7508, lng: 115.8039 });

export const WANNEROO_CONFIG = {
  source: 'wanneroo',
  label: 'City of Wanneroo',
  group: 'councils',
  endpoint: WANNEROO_ENDPOINT,
  baseUrl: WANNEROO_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: WANNEROO_LGA_CENTROID,
  minExpectedListings: 1,
  searchParam: [
    { key: 'classname', values: ['AWPT.Event'], or: 'true', operator: 'eq' },
    { key: 'searchindexes', values: ['Events'], or: 'true', operator: 'eq' },
    { key: 'nodealiaspath', values: ['/'], or: 'true', operator: 'eq' },
    { key: 'FilterIsExpired', values: ['false'], or: 'true', operator: 'eq' }
  ],
  searchFilter: [],
  defaultOrganizer: {
    id: 'org_city_of_wanneroo',
    name: 'City of Wanneroo',
    website: WANNEROO_BASE_URL
  }
};

/**
 * Creates a City of Wanneroo crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createWannerooCrawler(options = {}) {
  return createKenticoKendoCrawler(WANNEROO_CONFIG, options);
}
