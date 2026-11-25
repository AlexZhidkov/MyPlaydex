/**
 * Config-Driven Kentico `aw_pagetypelisting` HTML-Result Council Crawler Adapter
 * Zero-dependency adapter for councils serving Kentico AgencyWeb `pageTypeListing`
 * widgets via POST JSON payloads (`{ SI, OB, Q, PS, FS, PG, PR, IncludeFirst }`)
 * returning rendered `<article>` cards plus `recordCountValue` and `hasnextpage` markers.
 */

import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_MAX_ACTIVITIES,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_DELAY_MS,
  deriveDeterministicCouncilSourceId,
  filterCouncilItem,
  paginateCouncilPages,
  resolveCouncilCategoryAndSubcategory,
  sleepMs
} from './council-utils.js';
import {
  extractAttr,
  extractFirstElementByClass,
  extractTextByClassOrder,
  findBalancedTagEnd,
  hasClassToken,
  normalizeTimeRangeText,
  resolveUrl,
  stripHtmlTags,
  stripNonContentHtml
} from './html-utils.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; MyPlaydexCrawler/1.0; +https://myplaydex.com/bot)';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 20000;

function createTimeoutSignal(parentSignal, timeoutMs) {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return parentSignal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (parentSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([parentSignal, timeoutSignal]);
  }
  return parentSignal || timeoutSignal;
}

function extractHiddenInputValue(html, id) {
  const regex = new RegExp(`<input\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, 'i');
  const match = html.match(regex);
  if (!match) return null;
  return extractAttr(match[0], 'value');
}

function parsePaginationMarkers(html = '', page, pageSize, cardCount) {
  const hasNextRaw = extractHiddenInputValue(html, 'hasnextpage');
  if (hasNextRaw !== null) {
    return /^true$/i.test(hasNextRaw.trim());
  }

  const recordCountRaw = extractHiddenInputValue(html, 'recordCountValue');
  const recordCount = recordCountRaw !== null ? Number.parseInt(recordCountRaw, 10) : Number.NaN;
  if (Number.isFinite(recordCount)) {
    return page * pageSize < recordCount;
  }

  return cardCount >= pageSize;
}

function parseAriaLabelMetadata(ariaLabel = '') {
  if (!ariaLabel || typeof ariaLabel !== 'string') {
    return { title: '', categories: [], dateText: '', venueName: '' };
  }

  const labelPattern = /\b(Event Title|Category|Event Date|Event Venue)\s*:\s*/gi;
  const matches = [...ariaLabel.matchAll(labelPattern)];
  if (matches.length === 0) {
    return { title: '', categories: [], dateText: '', venueName: '' };
  }

  const fields = {};
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : ariaLabel.length;
    const rawValue = ariaLabel
      .slice(start, end)
      .replace(/\.?\s*Read more\.?$/i, '')
      .replace(/\.\s*$/, '')
      .trim();
    if (rawValue) {
      fields[key] = rawValue;
    }
  }

  return {
    title: fields['event title'] || '',
    categories: fields.category
      ? fields.category.split(/[,;|]+/).map(t => t.trim()).filter(Boolean)
      : [],
    dateText: fields['event date'] || '',
    venueName: fields['event venue'] || ''
  };
}

function extractNativeId(attrs = '') {
  return extractAttr(attrs, 'data-id')
    || extractAttr(attrs, 'data-event-id')
    || extractAttr(attrs, 'data-docid')
    || '';
}

function extractArticleCards(html = '', baseUrl = '') {
  const cleanHtml = stripNonContentHtml(html);
  const cards = [];
  const openArticleRegex = /<article\b([^>]*)>/gi;
  let match;

  while ((match = openArticleRegex.exec(cleanHtml)) !== null) {
    const attrs = match[1] || '';
    const contentStart = match.index + match[0].length;
    const { innerEnd, outerEnd } = findBalancedTagEnd(cleanHtml, 'article', contentStart);
    const innerHtml = cleanHtml.slice(contentStart, innerEnd);
    openArticleRegex.lastIndex = outerEnd;

    let nativeId = extractNativeId(attrs);

    let url = '';
    let ariaLabel = extractAttr(attrs, 'aria-label') || '';
    for (const anchorMatch of innerHtml.matchAll(/<a\b([^>]*)>/gi)) {
      if (!nativeId) {
        nativeId = extractNativeId(anchorMatch[1]);
      }
      if (!ariaLabel) {
        ariaLabel = extractAttr(anchorMatch[1], 'aria-label') || '';
      }
      if (!url) {
        const candidate = resolveUrl(baseUrl, extractAttr(anchorMatch[1], 'href'));
        if (candidate) url = candidate;
      }
    }
    url = url || baseUrl || null;
    const ariaMeta = parseAriaLabelMetadata(ariaLabel);

    const cardTitle = extractTextByClassOrder(innerHtml, ['card-title', 'event-title', 'title'])
      || (() => {
        const h = innerHtml.match(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i);
        return h ? stripHtmlTags(h[1]) : '';
      })();
    const title = ariaMeta.title || cardTitle;

    let dateText = extractTextByClassOrder(innerHtml, ['card-date', 'event-date', 'date']);
    let venueName = extractTextByClassOrder(innerHtml, ['card-venue', 'venue', 'location']);

    for (const liMatch of innerHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const liHtml = liMatch[1];
      const liText = stripHtmlTags(liHtml);
      if (!liText) continue;
      if (!dateText && /fa-calendar/i.test(liHtml)) {
        dateText = liText;
      } else if (!venueName && /fa-location/i.test(liHtml)) {
        venueName = liText;
      }
    }

    if (!dateText && ariaMeta.dateText) {
      dateText = ariaMeta.dateText;
    }
    if (!venueName && ariaMeta.venueName) {
      venueName = ariaMeta.venueName;
    }

    const tagsEl = extractFirstElementByClass(innerHtml, ['tags', 'event-categories', 'categories']);
    let rawTags = [];
    if (tagsEl) {
      const spanMatches = [...tagsEl.innerHtml.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
        .map(m => stripHtmlTags(m[1]))
        .filter(Boolean);
      rawTags = spanMatches.length > 0
        ? spanMatches
        : stripHtmlTags(tagsEl.innerHtml).split(/[,;|]+/).map(t => t.trim()).filter(Boolean);
    }
    if (rawTags.length === 0 && ariaMeta.categories.length > 0) {
      rawTags = ariaMeta.categories;
    }

    const description = extractTextByClassOrder(innerHtml, [
      'card-text',
      'card-description',
      'event-description',
      'description',
      'summary'
    ]) || (() => {
      const p = innerHtml.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
      return p ? stripHtmlTags(p[1]) : '';
    })();

    let isFree = false;
    const featureOpenRegex = /<([a-z0-9]+)\b([^>]*\bclass\s*=[^>]*)>/gi;
    let featureMatch;
    while ((featureMatch = featureOpenRegex.exec(innerHtml)) !== null) {
      const cls = extractAttr(featureMatch[2], 'class');
      if (!hasClassToken(cls, 'feature')) continue;
      const contentStart = featureMatch.index + featureMatch[0].length;
      const { innerEnd } = findBalancedTagEnd(innerHtml, featureMatch[1], contentStart);
      const featureText = stripHtmlTags(innerHtml.slice(contentStart, innerEnd));
      if (/^free$/i.test(featureText)) {
        isFree = true;
        break;
      }
    }

    cards.push({
      nativeId,
      url,
      title,
      description,
      dateText,
      venueName,
      rawTags,
      isFree
    });
  }

  return cards;
}

const DAY_NAME_TO_INT = {
  sunday: 0, sundays: 0,
  monday: 1, mondays: 1,
  tuesday: 2, tuesdays: 2,
  wednesday: 3, wednesdays: 3,
  thursday: 4, thursdays: 4,
  friday: 5, fridays: 5,
  saturday: 6, saturdays: 6
};

const MONTH_NAME_REGEX = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

function normalizeKenticoSchedule(dateText = '') {
  const scheduleText = normalizeTimeRangeText(dateText || '').trim();
  if (!scheduleText) {
    return { scheduleText: '', recurrence: 'none', dayOfWeek: null };
  }

  const dayMatch = scheduleText.match(/\b(sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?)\b/i);
  const dayOfWeek = dayMatch ? DAY_NAME_TO_INT[dayMatch[1].toLowerCase()] : null;

  const hasExplicitRecurrenceWord = /\b(every|weekly|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/i.test(scheduleText);
  const hasCalendarDate = MONTH_NAME_REGEX.test(scheduleText) || /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(scheduleText);
  const isWeekly = hasExplicitRecurrenceWord || (dayOfWeek !== null && !hasCalendarDate);

  return {
    scheduleText,
    recurrence: isWeekly ? 'weekly' : 'none',
    dayOfWeek: isWeekly ? dayOfWeek : null
  };
}

function mapCardToRawActivity(card, config) {
  const { category, subcategory } = resolveCouncilCategoryAndSubcategory(card.rawTags, card.title);
  const schedule = normalizeKenticoSchedule(card.dateText || '');
  const sourceId = deriveDeterministicCouncilSourceId({
    nativeId: card.nativeId,
    url: card.url,
    title: card.title,
    startTime: schedule.scheduleText
  });

  const organizer = config.defaultOrganizer && typeof config.defaultOrganizer === 'object'
    ? { ...config.defaultOrganizer }
    : undefined;

  return {
    source: config.source,
    source_id: sourceId,
    source_url: card.url,
    external_url: card.url,
    region_id: config.regionId || 'perth',
    title: card.title,
    description: card.description || '',
    category,
    subcategory,
    ...(organizer ? { organizer } : {}),
    venue: {
      ...(card.venueName ? { name: card.venueName } : {})
    },
    ...(card.venueName ? { venue_name: card.venueName } : {}),
    ...(schedule.scheduleText ? { start_time: schedule.scheduleText } : {}),
    ...(schedule.recurrence === 'weekly' ? { recurrence: 'weekly', end_date: null } : {}),
    ...(schedule.dayOfWeek !== null ? { day_of_week: schedule.dayOfWeek } : {}),
    cost_description: card.isFree ? 'Free' : '',
    display_price: card.isFree ? 'Free' : '',
    is_free: Boolean(card.isFree),
    demographics: {
      gender: 'all',
      age: 'all'
    }
  };
}

/**
 * Creates a config-driven Kentico `aw_pagetypelisting` HTML-result council crawler.
 *
 * @param {object} config
 * @param {object} [options]
 * @returns {object} Crawler instance
 */
export function createKenticoAwPageTypeListingCrawler(config, options = {}) {
  if (!config?.source || !config?.endpoint || !config?.baseUrl) {
    throw new Error('Kentico aw_pagetypelisting adapter requires source, endpoint, and baseUrl in config');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  const delayFn = options.delayFn || sleepMs;
  const pageSize = typeof options.pageSize === 'number' ? options.pageSize : (config.pageSize || DEFAULT_PAGE_SIZE);
  const firstPageSize = typeof options.firstPageSize === 'number' ? options.firstPageSize : (config.firstPageSize ?? pageSize);
  const maxPages = typeof options.maxPages === 'number' ? options.maxPages : (config.maxPages || DEFAULT_MAX_PAGES);
  const maxActivities = typeof options.maxActivities === 'number' ? options.maxActivities : (config.maxActivities || DEFAULT_MAX_ACTIVITIES);
  const pageDelayMs = typeof options.pageDelayMs === 'number' ? options.pageDelayMs : (config.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS);
  const horizonDays = typeof options.horizonDays === 'number' ? options.horizonDays : (config.horizonDays || DEFAULT_HORIZON_DAYS);
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const filterOptions = {
    now: options.now,
    horizonDays
  };

  return {
    name: config.source,
    label: config.label,
    group: config.group || 'councils',
    minExpectedListings: config.minExpectedListings ?? 1,
    ...(config.fallbackCentroid ? { fallbackCentroid: config.fallbackCentroid } : {}),
    ...(config.localOnly ? { localOnly: true } : {}),

    async fetchListings() {
      if (typeof fetchFn !== 'function') {
        throw new Error(`${config.label || config.source}: fetchFn is required`);
      }

      const seenSourceIds = new Set();
      let totalKept = 0;

      return paginateCouncilPages({
        maxPages,
        maxActivities,
        pageDelayMs,
        delayFn,
        fetchPage: async (page) => {
          const payloadBody = {
            SI: config.searchIndex ?? '',
            OB: config.orderBy ?? '',
            Q: config.query ?? '',
            PS: pageSize,
            FS: firstPageSize,
            PG: page,
            PR: Array.isArray(config.parameters) ? config.parameters : [],
            IncludeFirst: page === 1 ? (config.includeFirst ?? true) : false
          };

          const signal = createTimeoutSignal(options.signal, timeoutMs);
          const response = await fetchFn(config.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'User-Agent': config.userAgent || DEFAULT_USER_AGENT,
              ...(config.headers || {})
            },
            body: JSON.stringify(payloadBody),
            ...(signal ? { signal } : {})
          });

          if (!response.ok) {
            throw new Error(`${config.label || config.source} responded with HTTP ${response.status}: ${response.statusText || ''}`.trim());
          }

          const json = await response.json();
          const html = typeof json?.htmlResult === 'string' ? json.htmlResult : (typeof json?.html === 'string' ? json.html : '');
          const cards = extractArticleCards(html, config.baseUrl);
          const mappedItems = [];

          for (const card of cards) {
            if (totalKept >= maxActivities) break;
            if (!card.title) continue;

            const raw = mapCardToRawActivity(card, config);
            if (seenSourceIds.has(raw.source_id)) continue;
            seenSourceIds.add(raw.source_id);

            if (!filterCouncilItem({
              title: raw.title,
              category: card.rawTags.join(', '),
              venueName: raw.venue_name || '',
              start_time: raw.start_time || ''
            }, filterOptions)) {
              continue;
            }

            mappedItems.push(raw);
            totalKept += 1;
          }

          const hasMore = cards.length > 0 && parsePaginationMarkers(html, page, pageSize, cards.length);
          return {
            items: mappedItems,
            hasMore
          };
        }
      });
    }
  };
}
