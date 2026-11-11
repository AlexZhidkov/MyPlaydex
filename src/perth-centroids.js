/**
 * Static Centroid Dictionary for Greater Perth Suburbs and Postcodes
 * Provides zero-cost instant autocomplete without external geocoding API requests.
 */

export const PERTH_SUBURB_CENTROIDS = [
  { name: 'Perth', postcode: '6000', lat: -31.9505, lng: 115.8605 },
  { name: 'Northbridge', postcode: '6003', lat: -31.9472, lng: 115.8576 },
  { name: 'Highgate', postcode: '6003', lat: -31.9419, lng: 115.8679 },
  { name: 'East Perth', postcode: '6004', lat: -31.9566, lng: 115.8748 },
  { name: 'West Perth', postcode: '6005', lat: -31.9461, lng: 115.8450 },
  { name: 'Leederville', postcode: '6007', lat: -31.9366, lng: 115.8431 },
  { name: 'West Leederville', postcode: '6007', lat: -31.9405, lng: 115.8362 },
  { name: 'Subiaco', postcode: '6008', lat: -31.9463, lng: 115.8236 },
  { name: 'Shenton Park', postcode: '6008', lat: -31.9575, lng: 115.8080 },
  { name: 'Nedlands', postcode: '6009', lat: -31.9808, lng: 115.8093 },
  { name: 'Crawley', postcode: '6009', lat: -31.9828, lng: 115.8217 },
  { name: 'Claremont', postcode: '6010', lat: -31.9793, lng: 115.7801 },
  { name: 'Swanbourne', postcode: '6010', lat: -31.9744, lng: 115.7645 },
  { name: 'Cottesloe', postcode: '6011', lat: -31.9934, lng: 115.7578 },
  { name: 'Peppermint Grove', postcode: '6011', lat: -31.9986, lng: 115.7684 },
  { name: 'Mosman Park', postcode: '6012', lat: -32.0084, lng: 115.7629 },
  { name: 'Floreat', postcode: '6014', lat: -31.9392, lng: 115.7876 },
  { name: 'Wembley', postcode: '6014', lat: -31.9392, lng: 115.8097 },
  { name: 'City Beach', postcode: '6015', lat: -31.9328, lng: 115.7634 },
  { name: 'Mount Hawthorn', postcode: '6016', lat: -31.9213, lng: 115.8369 },
  { name: 'Osborne Park', postcode: '6017', lat: -31.8997, lng: 115.8159 },
  { name: 'Innaloo', postcode: '6018', lat: -31.8967, lng: 115.7956 },
  { name: 'Karrinyup', postcode: '6018', lat: -31.8753, lng: 115.7797 },
  { name: 'Scarborough', postcode: '6019', lat: -31.8942, lng: 115.7571 },
  { name: 'Trigg', postcode: '6020', lat: -31.8746, lng: 115.7573 },
  { name: 'Watermans Bay', postcode: '6020', lat: -31.8519, lng: 115.7561 },
  { name: 'Carine', postcode: '6020', lat: -31.8523, lng: 115.7798 },
  { name: 'Balcatta', postcode: '6021', lat: -31.8749, lng: 115.8239 },
  { name: 'Stirling', postcode: '6021', lat: -31.8847, lng: 115.8079 },
  { name: 'Hamersley', postcode: '6022', lat: -31.8542, lng: 115.8193 },
  { name: 'Duncraig', postcode: '6023', lat: -31.8318, lng: 115.7758 },
  { name: 'Greenwood', postcode: '6024', lat: -31.8267, lng: 115.8018 },
  { name: 'Warwick', postcode: '6024', lat: -31.8415, lng: 115.8123 },
  { name: 'Hillarys', postcode: '6025', lat: -31.8086, lng: 115.7486 },
  { name: 'Kallaroo', postcode: '6025', lat: -31.7891, lng: 115.7483 },
  { name: 'Padbury', postcode: '6025', lat: -31.8087, lng: 115.7667 },
  { name: 'Kingsley', postcode: '6026', lat: -31.8021, lng: 115.7997 },
  { name: 'Woodvale', postcode: '6026', lat: -31.7885, lng: 115.7958 },
  { name: 'Joondalup', postcode: '6027', lat: -31.7456, lng: 115.7660 },
  { name: 'Ocean Reef', postcode: '6027', lat: -31.7621, lng: 115.7410 },
  { name: 'Heathridge', postcode: '6027', lat: -31.7681, lng: 115.7588 },
  { name: 'Currambine', postcode: '6028', lat: -31.7238, lng: 115.7459 },
  { name: 'Kinross', postcode: '6028', lat: -31.7132, lng: 115.7419 },
  { name: 'Clarkson', postcode: '6030', lat: -31.6842, lng: 115.7289 },
  { name: 'Mindarie', postcode: '6030', lat: -31.6881, lng: 115.7068 },
  { name: 'Butler', postcode: '6036', lat: -31.6506, lng: 115.7131 },
  { name: 'Alkimos', postcode: '6038', lat: -31.6111, lng: 115.6889 },
  { name: 'Yanchep', postcode: '6035', lat: -31.5510, lng: 115.6322 },
  { name: 'Mount Lawley', postcode: '6050', lat: -31.9317, lng: 115.8753 },
  { name: 'Maylands', postcode: '6051', lat: -31.9312, lng: 115.8947 },
  { name: 'Inglewood', postcode: '6052', lat: -31.9202, lng: 115.8812 },
  { name: 'Bedford', postcode: '6052', lat: -31.9089, lng: 115.8893 },
  { name: 'Bayswater', postcode: '6053', lat: -31.9167, lng: 115.9126 },
  { name: 'Bassendean', postcode: '6054', lat: -31.9042, lng: 115.9463 },
  { name: 'Guildford', postcode: '6055', lat: -31.8986, lng: 115.9722 },
  { name: 'Midland', postcode: '6056', lat: -31.8906, lng: 116.0028 },
  { name: 'Swan View', postcode: '6056', lat: -31.8845, lng: 116.0331 },
  { name: 'Kalamunda', postcode: '6076', lat: -31.9719, lng: 116.0578 },
  { name: 'Mundaring', postcode: '6073', lat: -31.9022, lng: 116.1667 },
  { name: 'Dianella', postcode: '6059', lat: -31.8911, lng: 115.8697 },
  { name: 'Yokine', postcode: '6060', lat: -31.9028, lng: 115.8483 },
  { name: 'Morley', postcode: '6062', lat: -31.8903, lng: 115.9039 },
  { name: 'Mirrabooka', postcode: '6061', lat: -31.8658, lng: 115.8622 },
  { name: 'Ballajura', postcode: '6066', lat: -31.8481, lng: 115.9011 },
  { name: 'Ellenbrook', postcode: '6069', lat: -31.7656, lng: 115.9928 },
  { name: 'Wanneroo', postcode: '6065', lat: -31.7508, lng: 115.8039 },
  { name: 'Victoria Park', postcode: '6100', lat: -31.9753, lng: 115.8978 },
  { name: 'Burswood', postcode: '6100', lat: -31.9619, lng: 115.8928 },
  { name: 'Rivervale', postcode: '6103', lat: -31.9611, lng: 115.9103 },
  { name: 'Belmont', postcode: '6104', lat: -31.9406, lng: 115.9328 },
  { name: 'Cloverdale', postcode: '6105', lat: -31.9622, lng: 115.9400 },
  { name: 'Welshpool', postcode: '6106', lat: -31.9961, lng: 115.9367 },
  { name: 'Cannington', postcode: '6107', lat: -32.0167, lng: 115.9333 },
  { name: 'Thornlie', postcode: '6108', lat: -32.0542, lng: 115.9583 },
  { name: 'Gosnells', postcode: '6110', lat: -32.0792, lng: 115.9972 },
  { name: 'Armadale', postcode: '6112', lat: -32.1528, lng: 116.0150 },
  { name: 'South Perth', postcode: '6151', lat: -31.9808, lng: 115.8617 },
  { name: 'Como', postcode: '6152', lat: -31.9978, lng: 115.8633 },
  { name: 'Applecross', postcode: '6153', lat: -32.0156, lng: 115.8344 },
  { name: 'Booragoon', postcode: '6154', lat: -32.0369, lng: 115.8306 },
  { name: 'Canning Vale', postcode: '6155', lat: -32.0722, lng: 115.9083 },
  { name: 'Willetton', postcode: '6155', lat: -32.0556, lng: 115.8833 },
  { name: 'Melville', postcode: '6156', lat: -32.0372, lng: 115.8019 },
  { name: 'Palmyra', postcode: '6157', lat: -32.0372, lng: 115.7828 },
  { name: 'East Fremantle', postcode: '6158', lat: -32.0378, lng: 115.7644 },
  { name: 'North Fremantle', postcode: '6159', lat: -32.0322, lng: 115.7539 },
  { name: 'Fremantle', postcode: '6160', lat: -32.0569, lng: 115.7439 },
  { name: 'South Fremantle', postcode: '6162', lat: -32.0711, lng: 115.7544 },
  { name: 'Cockburn Central', postcode: '6164', lat: -32.1278, lng: 115.8569 },
  { name: 'Coogee', postcode: '6166', lat: -32.1319, lng: 115.7667 },
  { name: 'Rockingham', postcode: '6168', lat: -32.2817, lng: 115.7331 },
  { name: 'Mandurah', postcode: '6210', lat: -32.5361, lng: 115.7225 }
];

export const DEFAULT_PRESET_SUBURBS = [
  'Perth',
  'Scarborough',
  'Fremantle',
  'Joondalup',
  'Cottesloe',
  'Subiaco',
  'Victoria Park',
  'Midland'
];

/**
 * Searches the Greater Perth centroids dictionary by suburb name or postcode prefix/substring.
 *
 * @param {string} rawQuery
 * @param {number} [limit=8]
 * @returns {Array<{ name: string, postcode: string, lat: number, lng: number }>}
 */
export function searchSuburbs(rawQuery = '', limit = 8) {
  const query = String(rawQuery).trim().toLowerCase();

  if (!query) {
    return DEFAULT_PRESET_SUBURBS.map((name) =>
      PERTH_SUBURB_CENTROIDS.find((s) => s.name === name)
    ).filter(Boolean).slice(0, limit);
  }

  const isNumeric = /^\d+$/.test(query);

  const scored = [];

  for (const item of PERTH_SUBURB_CENTROIDS) {
    const nameLower = item.name.toLowerCase();
    const postcode = item.postcode;

    if (isNumeric) {
      if (postcode === query) {
        scored.push({ item, score: 100 });
      } else if (postcode.startsWith(query)) {
        scored.push({ item, score: 80 });
      }
    } else {
      if (nameLower === query) {
        scored.push({ item, score: 100 });
      } else if (nameLower.startsWith(query)) {
        scored.push({ item, score: 70 });
      } else if (nameLower.includes(query)) {
        scored.push({ item, score: 40 });
      } else if (postcode.includes(query)) {
        scored.push({ item, score: 30 });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Finds a single suburb matching an exact name or postcode.
 *
 * @param {string} identifier
 * @returns {{ name: string, postcode: string, lat: number, lng: number } | null}
 */
export function getSuburbByPostcodeOrName(identifier = '') {
  const clean = String(identifier).trim().toLowerCase();
  if (!clean) return null;

  return (
    PERTH_SUBURB_CENTROIDS.find(
      (s) => s.name.toLowerCase() === clean || s.postcode === clean
    ) || null
  );
}

/**
 * Converts a suburb name into a URL-friendly slug.
 *
 * @param {string} name Suburb name
 * @returns {string} URL slug
 */
export function suburbNameToSlug(name = '') {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Finds a single suburb matching an exact name, postcode, or URL slug.
 *
 * @param {string} identifier Suburb name, postcode, or slug
 * @returns {{ name: string, postcode: string, lat: number, lng: number } | null}
 */
export function getSuburbBySlugOrName(identifier = '') {
  const directMatch = getSuburbByPostcodeOrName(identifier);
  if (directMatch) return directMatch;

  const targetSlug = suburbNameToSlug(identifier);
  if (!targetSlug) return null;

  return (
    PERTH_SUBURB_CENTROIDS.find((s) => suburbNameToSlug(s.name) === targetSlug) || null
  );
}

/**
 * Finds the nearest Greater Perth suburb centroid to a given set of coordinates.
 *
 * @param {{ lat: number, lng: number }} coords
 * @returns {{ name: string, postcode: string, lat: number, lng: number } | null}
 */
export function findNearestSuburb(coords) {
  if (!coords || typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
    return null;
  }

  let nearest = null;
  let minDistance = Infinity;

  for (const suburb of PERTH_SUBURB_CENTROIDS) {
    const dLat = suburb.lat - coords.lat;
    const dLng = suburb.lng - coords.lng;
    const distSq = dLat * dLat + dLng * dLng;
    if (distSq < minDistance) {
      minDistance = distSq;
      nearest = suburb;
    }
  }

  return nearest;
}
