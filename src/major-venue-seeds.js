/**
 * Curated Major Greater Perth Venue Seed Registry (ADR 0015)
 * Defines the official "What's On" index URLs and canonical Venue metadata
 * for major Greater Perth ticketed and performing arts Venues.
 */

import { slugify } from './sanitizer.js';

export const MAJOR_VENUE_SEEDS = Object.freeze([
  Object.freeze({
    slug: 'optus-stadium',
    name: 'Optus Stadium',
    aliases: Object.freeze(['Perth Stadium']),
    whatsOnUrl: 'https://optusstadium.com.au/whats-on',
    address: '333 Victoria Park Dr, Burswood WA 6100',
    suburb: 'Burswood',
    coordinates: Object.freeze({ lat: -31.9511, lng: 115.8890 }),
    defaultCategory: 'sports',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'rac-arena',
    name: 'RAC Arena',
    aliases: Object.freeze(['Perth Arena']),
    whatsOnUrl: 'https://www.racarena.com.au/whats-on',
    address: '700 Wellington St, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9484, lng: 115.8521 }),
    defaultCategory: 'music',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'crown-perth',
    name: 'Crown Perth',
    aliases: Object.freeze(['Crown Theatre Perth', 'Crown Theatre']),
    whatsOnUrl: 'https://www.crownperth.com.au/entertainment/crown-theatre',
    address: 'Great Eastern Hwy, Burswood WA 6100',
    suburb: 'Burswood',
    coordinates: Object.freeze({ lat: -31.9617, lng: 115.8959 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'perth-concert-hall',
    name: 'Perth Concert Hall',
    aliases: Object.freeze(['PCH']),
    whatsOnUrl: 'https://www.perthconcerthall.com.au/events',
    address: '5 St Georges Tce, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9592, lng: 115.8648 }),
    defaultCategory: 'music',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'pcec',
    name: 'Perth Convention and Exhibition Centre',
    aliases: Object.freeze(['PCEC', 'Riverside Theatre']),
    whatsOnUrl: 'https://www.pcec.com.au/visitors/events/',
    address: '21 Mounts Bay Rd, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9565, lng: 115.8531 }),
    defaultCategory: 'community',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'hbf-park',
    name: 'HBF Park',
    aliases: Object.freeze(['Perth Rectangular Stadium', 'nib Stadium']),
    whatsOnUrl: 'https://www.hbfpark.com.au/events/upcoming-events',
    address: '310 Pier St, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9458, lng: 115.8700 }),
    defaultCategory: 'sports',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'hbf-stadium',
    name: 'HBF Stadium',
    aliases: Object.freeze(['Challenge Stadium', 'Perth HPC', 'Perth High Performance Centre']),
    whatsOnUrl: 'https://www.perthhpc.com.au/events/upcoming-events',
    address: '100 Stephenson Ave, Mount Claremont WA 6010',
    suburb: 'Mount Claremont',
    coordinates: Object.freeze({ lat: -31.9525, lng: 115.7822 }),
    defaultCategory: 'sports',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'hbf-arena',
    name: 'HBF Arena',
    aliases: Object.freeze(['Arena Joondalup']),
    whatsOnUrl: 'https://www.arenajoondalup.com.au/events/upcoming-events',
    address: 'Kennedya Dr, Joondalup WA 6027',
    suburb: 'Joondalup',
    coordinates: Object.freeze({ lat: -31.7346, lng: 115.7607 }),
    defaultCategory: 'sports',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'mandurah-pac',
    name: 'Mandurah Performing Arts Centre',
    aliases: Object.freeze(['MPAC', 'ManPAC']),
    whatsOnUrl: 'https://www.manpac.com.au/whats-on/',
    address: '9 Ormsby Tce, Mandurah WA 6210',
    suburb: 'Mandurah',
    coordinates: Object.freeze({ lat: -32.5269, lng: 115.7217 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'his-majestys-theatre',
    name: "His Majesty's Theatre",
    aliases: Object.freeze(['His Maj']),
    whatsOnUrl: 'https://www.artsculturetrust.wa.gov.au/venues/his-majestys-theatre/whats-on/',
    address: '825 Hay St, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9522, lng: 115.8528 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'state-theatre-centre',
    name: 'State Theatre Centre of WA',
    aliases: Object.freeze(['State Theatre Centre', 'STCWA']),
    whatsOnUrl: 'https://www.artsculturetrust.wa.gov.au/venues/state-theatre-centre-of-wa/whats-on/',
    address: '174-176 William St, Perth WA 6000',
    suburb: 'Perth',
    coordinates: Object.freeze({ lat: -31.9499, lng: 115.8594 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'astor-theatre',
    name: 'Astor Theatre',
    aliases: Object.freeze(['Astor Theatre Perth']),
    whatsOnUrl: 'https://astortheatreperth.com/event/',
    address: '659 Beaufort St, Mount Lawley WA 6050',
    suburb: 'Mount Lawley',
    coordinates: Object.freeze({ lat: -31.9341, lng: 115.8721 }),
    defaultCategory: 'music',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'fremantle-arts-centre',
    name: 'Fremantle Arts Centre',
    aliases: Object.freeze(['FAC', 'Walyalup Fremantle Arts Centre']),
    whatsOnUrl: 'https://wfac.org.au/program/on-now/',
    address: '1 Finnerty St, Fremantle WA 6160',
    suburb: 'Fremantle',
    coordinates: Object.freeze({ lat: -32.0477, lng: 115.7540 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'subiaco-arts-centre',
    name: 'Subiaco Arts Centre',
    aliases: Object.freeze(['SAC']),
    whatsOnUrl: 'https://www.artsculturetrust.wa.gov.au/venues/subiaco-arts-centre/whats-on/',
    address: '180 Hamersley Rd, Subiaco WA 6008',
    suburb: 'Subiaco',
    coordinates: Object.freeze({ lat: -31.9519, lng: 115.8209 }),
    defaultCategory: 'arts',
    regionId: 'perth'
  }),
  Object.freeze({
    slug: 'the-rechabite',
    name: 'The Rechabite',
    aliases: Object.freeze(['Rechabite Hall']),
    whatsOnUrl: 'https://therechabite.com.au/whats-on/',
    address: '224 William St, Northbridge WA 6003',
    suburb: 'Northbridge',
    coordinates: Object.freeze({ lat: -31.9489, lng: 115.8594 }),
    defaultCategory: 'music',
    regionId: 'perth'
  })
]);

function matchesSeedField(value, trimmed, normalizedSlug) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return value.toLowerCase() === trimmed || slugify(value) === normalizedSlug;
}

/**
 * Finds a major Venue seed by slug, name, or alias (case-insensitive / slug-normalized).
 *
 * @param {string} query
 * @param {Array<object>} [seeds=MAJOR_VENUE_SEEDS]
 * @returns {object|null}
 */
export function findMajorVenueSeed(query, seeds = MAJOR_VENUE_SEEDS) {
  if (typeof query !== 'string' || !query.trim() || !Array.isArray(seeds)) {
    return null;
  }

  const trimmed = query.trim().toLowerCase();
  const normalizedSlug = slugify(trimmed);

  for (const seed of seeds) {
    if (!seed) continue;
    if (matchesSeedField(seed.slug, trimmed, normalizedSlug) || matchesSeedField(seed.name, trimmed, normalizedSlug)) {
      return seed;
    }
    if (Array.isArray(seed.aliases) && seed.aliases.some(alias => matchesSeedField(alias, trimmed, normalizedSlug))) {
      return seed;
    }
  }

  return null;
}
