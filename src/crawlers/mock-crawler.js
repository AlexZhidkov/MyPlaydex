/**
 * Mock Perth Activities Crawler
 * Provides deterministic offline sample activities for testing and dry-run validation.
 */

import { MOCK_PERTH_ACTIVITIES } from '../mock-perth-activities.js';

export function createMockCrawler() {
  return {
    name: 'mock',

    async fetchListings() {
      return MOCK_PERTH_ACTIVITIES.map(item => ({ ...item }));
    }
  };
}
