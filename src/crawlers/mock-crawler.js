/**
 * Mock Perth Activities Crawler
 * Provides deterministic offline sample activities for testing and dry-run validation.
 */

import { MOCK_PERTH_ACTIVITIES } from '../mock-perth-activities.js';

export function createMockCrawler() {
  return {
    name: 'mock',

    async fetchListings() {
      return MOCK_PERTH_ACTIVITIES.map(item => ({
        source: 'mock',
        source_id: item.id,
        title: item.title,
        sport: item.sport,
        type: item.type || 'social',
        venue_name: item.venue.name,
        address: item.venue.address,
        coordinates: item.venue.coordinates,
        geohash: item.venue.geohash,
        start_time: item.schedule?.start_time,
        end_time: item.schedule?.end_time,
        cost_description: item.cost_description,
        is_free: item.is_free,
        demographics: item.demographics,
        club_name: item.club_name,
        external_url: item.external_url
      }));
    }
  };
}
