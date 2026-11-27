/**
 * Confirmed dead or permanently unreachable Organizer website domains excluded from
 * the Firecrawl Organizer Website drip sync (normalized lowercase hostnames without `www.`).
 */

export const DEFAULT_SKIPPED_ORGANIZER_DOMAINS = Object.freeze([
  'unigames.com.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'avacademy.com.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'amateurarcherycentre.myclub.org.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'apacherebels.com', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'applecrossswimmingclub.com.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'aquajetsswimmingclubwa.com.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'ajnc.org.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'thearcherycentre.com.au', // ERR_CERT_COMMON_NAME_INVALID
  'abrc.asn.au', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'armadaleraiders.com', // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
  'members.iinet.net.au', // Defunct iiNet member pages / ERR_SOCKS_CONNECTION_FAILED
  'armadaletennis.myclub.org.au' // NXDOMAIN / ERR_SOCKS_CONNECTION_FAILED
]);

function normalizeHost(hostname = '') {
  return String(hostname).trim().toLowerCase().replace(/^www\./, '');
}

/**
 * Returns true if `websiteUrl` belongs to a domain in `skipDomains`
 * (matching exact normalized host or any subdomain).
 *
 * @param {string} websiteUrl
 * @param {Iterable<string>} [skipDomains=DEFAULT_SKIPPED_ORGANIZER_DOMAINS]
 * @returns {boolean}
 */
export function isSkippedOrganizerDomain(websiteUrl, skipDomains = DEFAULT_SKIPPED_ORGANIZER_DOMAINS) {
  if (typeof websiteUrl !== 'string' || !websiteUrl.trim()) {
    return false;
  }
  let host;
  try {
    host = normalizeHost(new URL(websiteUrl).hostname);
  } catch {
    return false;
  }
  if (!host) {
    return false;
  }

  for (const rawEntry of skipDomains || []) {
    const entry = normalizeHost(rawEntry);
    if (!entry) continue;
    if (host === entry || host.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}
