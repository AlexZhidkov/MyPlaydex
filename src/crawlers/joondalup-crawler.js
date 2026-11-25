/**
 * City of Joondalup Activities Crawler
 * Configured on top of the shared Kentico `aw_pagetypelisting` HTML-result adapter.
 */

import { createKenticoAwPageTypeListingCrawler } from './kentico-aw-pagetypelisting-adapter.js';

export const JOONDALUP_ENDPOINT = 'https://www.joondalup.wa.gov.au/search/htmlresult';
export const JOONDALUP_BASE_URL = 'https://www.joondalup.wa.gov.au';
export const JOONDALUP_LGA_CENTROID = Object.freeze({ lat: -31.7456, lng: 115.7660 });

export const JOONDALUP_CONFIG = {
  source: 'joondalup',
  label: 'City of Joondalup',
  group: 'councils',
  endpoint: JOONDALUP_ENDPOINT,
  baseUrl: JOONDALUP_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: JOONDALUP_LGA_CENTROID,
  minExpectedListings: 1,
  searchIndex: 'Events',
  orderBy: '',
  pageSize: 50,
  firstPageSize: 50,
  parameters: [
    { key: 'widgetclassname', values: [{ value: 'AWEventSmartSearchListing' }] },
    { key: 'widgettemplatename', values: [{ value: 'AWEventSmartSearchListing' }] },
    { key: 'transformationname', values: [{ value: 'AWPT.Event.SmartSearchItem' }] },
    { key: 'headertransformationname', values: [{ value: 'AWPT.Event.SmartSearchHeader' }] },
    { key: 'footertransformationname', values: [{ value: 'AWPT.Event.SmartSearchFooter' }] },
    { key: 'classname', values: [{ value: 'AWPT.Event' }] },
    { key: 'nodealiaspath', values: [{ value: '/What-s-On/Events-Calendar' }] },
    { key: 'FilterIsExpired', values: [{ value: 'false' }] },
    { key: 'EventPossibleStart', values: [{ value: '[0 TO 99999999999999]' }] }
  ],
  defaultOrganizer: {
    id: 'org_city_of_joondalup',
    name: 'City of Joondalup',
    website: JOONDALUP_BASE_URL
  }
};

/**
 * Creates a City of Joondalup crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createJoondalupCrawler(options = {}) {
  return createKenticoAwPageTypeListingCrawler(JOONDALUP_CONFIG, options);
}
