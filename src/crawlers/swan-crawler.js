/**
 * City of Swan Activities Crawler
 * Configured on top of the shared Kentico `aw_pagetypelisting` HTML-result adapter.
 */

import { createKenticoAwPageTypeListingCrawler } from './kentico-aw-pagetypelisting-adapter.js';

export const SWAN_ENDPOINT = 'https://www.swan.wa.gov.au/v1/aapi/search/htmlresult';
export const SWAN_BASE_URL = 'https://www.swan.wa.gov.au';
export const SWAN_LGA_CENTROID = Object.freeze({ lat: -31.8906, lng: 116.0028 });

export const SWAN_CONFIG = {
  source: 'swan',
  label: 'City of Swan',
  group: 'councils',
  endpoint: SWAN_ENDPOINT,
  baseUrl: SWAN_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: SWAN_LGA_CENTROID,
  minExpectedListings: 1,
  searchIndex: 'Events',
  orderBy: 'PossibleStart ASC',
  pageSize: 50,
  firstPageSize: 50,
  parameters: [
    { key: 'transformationname', values: [{ value: 'AWPT.Event.SmartSearchItem' }] },
    { key: 'headertransformationname', values: [{ value: 'AWPT.Event.SmartSearchHeader' }] },
    { key: 'footertransformationname', values: [{ value: 'AWPT.Event.SmartSearchFooter' }] },
    { key: 'classname', values: [{ value: 'AWPT.Event' }] },
    { key: 'FilterIsExpired', values: [{ value: 'False' }] },
    { key: 'searchindexes', values: [{ value: 'Events' }] },
    { key: 'nodealiaspath', values: [{ value: '/explore-and-do' }] }
  ],
  defaultOrganizer: {
    id: 'org_city_of_swan',
    name: 'City of Swan',
    website: SWAN_BASE_URL
  }
};

/**
 * Creates a City of Swan crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createSwanCrawler(options = {}) {
  return createKenticoAwPageTypeListingCrawler(SWAN_CONFIG, options);
}
