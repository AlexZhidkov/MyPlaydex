/**
 * City of Rockingham Activities Crawler
 * Configured on top of the shared Kentico/Kendo UI council adapter.
 */

import { createKenticoKendoCrawler } from './kentico-kendo-adapter.js';

export const ROCKINGHAM_ENDPOINT = 'https://rockingham.wa.gov.au/ksearch/eventresult';
export const ROCKINGHAM_BASE_URL = 'https://rockingham.wa.gov.au';
export const ROCKINGHAM_LGA_CENTROID = Object.freeze({ lat: -32.2817, lng: 115.7331 });

export const ROCKINGHAM_CONFIG = {
  source: 'rockingham',
  label: 'City of Rockingham',
  group: 'councils',
  endpoint: ROCKINGHAM_ENDPOINT,
  baseUrl: ROCKINGHAM_BASE_URL,
  regionId: 'perth',
  fallbackCentroid: ROCKINGHAM_LGA_CENTROID,
  minExpectedListings: 1,
  searchParam: [
    { key: 'classname', values: ['AWPT.Event'], or: 'true', operator: 'eq' },
    { key: 'searchindexes', values: ['events'], or: 'true', operator: 'eq' },
    { key: 'nodealiaspath', values: ['/'], or: 'true', operator: 'eq' },
    { key: 'FilterIsExpired', values: ['false'], or: 'true', operator: 'eq' }
  ],
  searchFilter: [],
  defaultOrganizer: {
    id: 'org_city_of_rockingham',
    name: 'City of Rockingham',
    website: ROCKINGHAM_BASE_URL
  }
};

/**
 * Creates a City of Rockingham crawler instance.
 *
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createRockinghamCrawler(options = {}) {
  return createKenticoKendoCrawler(ROCKINGHAM_CONFIG, options);
}
