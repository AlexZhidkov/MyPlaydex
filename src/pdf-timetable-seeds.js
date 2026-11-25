/**
 * Tier-1 Leisure-Centre & Council PDF Timetable Seeds & URL Scoring (ADR 0013)
 * Provides the curated Greater Perth leisure-centre/council PDF timetable seed list
 * and PDF URL classification/scoring helpers for `/v2/map` discovery.
 */

export const DEFAULT_PDF_SCRAPE_TIMEOUT_MS = 60000;

export const DEFAULT_PDF_TIMETABLE_SEEDS = Object.freeze([
  {
    name: 'cockburn_arc_group_fitness',
    url: 'https://www.cockburnarc.com.au/CockburnARC/media/Files/Timetables/Group-Fitness-Timetable.pdf',
    organizerName: 'City of Cockburn - Cockburn ARC',
    venueName: 'Cockburn ARC',
    suburb: 'Cockburn Central'
  },
  {
    name: 'beatty_park_group_fitness',
    url: 'https://www.beattypark.com.au/files/sharedassets/beattypark/v/1/documents/fitness/group-fitness-timetable.pdf',
    organizerName: 'City of Vincent - Beatty Park Leisure Centre',
    venueName: 'Beatty Park Leisure Centre',
    suburb: 'North Perth'
  },
  {
    name: 'craigie_leisure_centre_group_fitness',
    url: 'https://www.joondalup.wa.gov.au/wp-content/uploads/2024/01/Craigie-Leisure-Centre-Group-Fitness-Timetable.pdf',
    organizerName: 'City of Joondalup - Craigie Leisure Centre',
    venueName: 'Craigie Leisure Centre',
    suburb: 'Craigie'
  },
  {
    name: 'aqualife_group_fitness',
    url: 'https://www.victoriapark.wa.gov.au/files/assets/public/v/1/documents/aqualife/aqualife-group-fitness-timetable.pdf',
    organizerName: 'Town of Victoria Park - Aqualife Centre',
    venueName: 'Aqualife Centre',
    suburb: 'East Victoria Park'
  },
  {
    name: 'terry_tyzack_group_fitness',
    url: 'https://www.stirling.wa.gov.au/Stirling/media/Documents/Leisure%20Centres/Terry-Tyzack-Group-Fitness-Timetable.pdf',
    organizerName: 'City of Stirling - Terry Tyzack Aquatic Centre',
    venueName: 'Terry Tyzack Aquatic Centre',
    suburb: 'Inglewood'
  },
  {
    name: 'bayswater_waves_group_fitness',
    url: 'https://www.bayswaterwaves.wa.gov.au/files/assets/waves/documents/group-fitness-timetable.pdf',
    organizerName: 'City of Bayswater - Bayswater Waves',
    venueName: 'Bayswater Waves',
    suburb: 'Embleton'
  },
  {
    name: 'cannington_leisureplex_group_fitness',
    url: 'https://www.canning.wa.gov.au/CanningWebsite/media/Files/Leisureplex/Cannington-Leisureplex-Group-Fitness-Timetable.pdf',
    organizerName: 'City of Canning - Cannington Leisureplex',
    venueName: 'Cannington Leisureplex',
    suburb: 'Cannington'
  },
  {
    name: 'melville_leisurefit_booragoon',
    url: 'https://www.melvillecity.com.au/files/assets/public/v/1/documents/leisurefit/leisurefit-booragoon-group-fitness-timetable.pdf',
    organizerName: 'City of Melville - LeisureFit Booragoon',
    venueName: 'LeisureFit Booragoon',
    suburb: 'Booragoon'
  }
]);

const TIMETABLE_PDF_KEYWORD_REGEX = /(?:timetable|schedule|classes|sessions|program|programme|fitness|aquatic|pool|swim|fixtures|events|calendar|whats-on|whatson|activities)/i;
const NOISE_PDF_KEYWORD_REGEX = /(?:privacy|policy|terms|conditions|annual[-_ ]report|agm|minutes|constitution|bylaw|code[-_ ]of[-_ ]conduct|waiver|membership[-_ ]form|application[-_ ]form|invoice|receipt|floor[-_ ]?plan|parking[-_ ]?map|site[-_ ]?map)/i;

/**
 * Checks whether a URL's pathname points to a `.pdf` document.
 *
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isPdfUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return /\.pdf(?:$|[?#])/i.test(trimmed);
  }
}

function extractPdfLowerPath(rawOrParsedUrl) {
  if (rawOrParsedUrl instanceof URL) {
    return rawOrParsedUrl.pathname.toLowerCase().endsWith('.pdf')
      ? `${rawOrParsedUrl.pathname}${rawOrParsedUrl.search}`.toLowerCase()
      : null;
  }
  if (!isPdfUrl(rawOrParsedUrl)) return null;
  try {
    const parsed = new URL(String(rawOrParsedUrl).trim());
    return `${parsed.pathname}${parsed.search}`.toLowerCase();
  } catch {
    return String(rawOrParsedUrl).trim().toLowerCase();
  }
}

/**
 * Checks whether a `.pdf` URL looks like an activity/class timetable rather than
 * administrative noise (privacy policy, annual report, AGM minutes, forms).
 *
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isTimetablePdfUrl(rawUrl) {
  const lowerPath = extractPdfLowerPath(rawUrl);
  if (!lowerPath || NOISE_PDF_KEYWORD_REGEX.test(lowerPath)) {
    return false;
  }
  return TIMETABLE_PDF_KEYWORD_REGEX.test(lowerPath);
}

/**
 * Scores a parsed `.pdf` URL for `/v2/map` candidate selection.
 * Returns `null` for non-activity administrative PDFs, a high score (92 - capped segment penalty)
 * for timetable/schedule PDFs, and a lower fallback score for neutral PDFs.
 *
 * @param {URL} parsedUrl
 * @returns {number|null}
 */
export function scorePdfCandidateUrl(parsedUrl) {
  const lowerPath = extractPdfLowerPath(parsedUrl);
  if (!lowerPath || NOISE_PDF_KEYWORD_REGEX.test(lowerPath)) {
    return null;
  }

  const segments = parsedUrl.pathname.split('/').filter(Boolean).length;
  const searchPenalty = parsedUrl.search ? 5 : 0;

  if (TIMETABLE_PDF_KEYWORD_REGEX.test(lowerPath)) {
    return 92 - Math.min(segments, 5) * 2 - searchPenalty;
  }

  return 40 - segments * 3 - searchPenalty;
}
