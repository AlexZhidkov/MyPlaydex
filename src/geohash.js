/**
 * Geohash encoding utility
 * Implements standard Morton curve Base32 geohashing without external dependencies.
 */

const BASE32_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const BITS = [16, 8, 4, 2, 1];

/**
 * Encodes latitude and longitude into a standard Base32 geohash string.
 *
 * @param {number} lat - Latitude in degrees (-90 to 90)
 * @param {number} lng - Longitude in degrees (-180 to 180)
 * @param {number} [precision=9] - Length of geohash string (default: 9 for precision ~4.8m)
 * @returns {string} Geohash string
 */
export function encodeGeohash(lat, lng, precision = 9) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
    throw new Error('Invalid coordinates: latitude and longitude must be numbers');
  }

  if (lat < -90 || lat > 90) {
    throw new Error('Latitude must be between -90 and 90 degrees');
  }

  if (lng < -180 || lng > 180) {
    throw new Error('Longitude must be between -180 and 180 degrees');
  }

  let minLat = -90.0;
  let maxLat = 90.0;
  let minLng = -180.0;
  let maxLng = 180.0;

  const hashChars = [];
  let bit = 0;
  let charCode = 0;
  let isEvenBit = true;

  while (hashChars.length < precision) {
    if (isEvenBit) {
      const midLng = (minLng + maxLng) / 2;
      if (lng >= midLng) {
        charCode |= BITS[bit];
        minLng = midLng;
      } else {
        maxLng = midLng;
      }
    } else {
      const midLat = (minLat + maxLat) / 2;
      if (lat >= midLat) {
        charCode |= BITS[bit];
        minLat = midLat;
      } else {
        maxLat = midLat;
      }
    }

    isEvenBit = !isEvenBit;

    if (bit < 4) {
      bit += 1;
    } else {
      hashChars.push(BASE32_ALPHABET[charCode]);
      bit = 0;
      charCode = 0;
    }
  }

  return hashChars.join('');
}
