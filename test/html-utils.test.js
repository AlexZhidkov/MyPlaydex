import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHtmlEntities,
  stripNonContentHtml,
  stripHtmlTags,
  extractAttr,
  findBalancedTagEnd,
  hasClassToken,
  extractFirstElementByClass,
  extractTextByClassOrder,
  resolveUrl,
  normalizeTimeRangeText
} from '../src/crawlers/html-utils.js';

test('decodeHtmlEntities decodes named, decimal, and hex HTML entities', () => {
  assert.equal(decodeHtmlEntities('Netball &amp; Social &mdash; Caf&eacute; &Eacute;lan'), 'Netball & Social — Café Élan');
  assert.equal(decodeHtmlEntities('Kids&#39; &rsquo;Club&ldquo; &hellip;'), 'Kids\' ’Club“ …');
  assert.equal(decodeHtmlEntities('Hex &#x26; Dec &#38;'), 'Hex & Dec &');
  assert.equal(decodeHtmlEntities(''), '');
  assert.equal(decodeHtmlEntities(null), '');
});

test('stripNonContentHtml removes HTML comments, script blocks, and style blocks', () => {
  const raw = '<!-- header --><style>.a { color: red; }</style><div>Hello</div><script>alert(1)</script>';
  assert.equal(stripNonContentHtml(raw), '<div>Hello</div>');
  assert.equal(stripNonContentHtml(''), '');
});

test('stripHtmlTags normalizes whitespace and preserves spacing across block and br/hr tags', () => {
  const html = '<p>Line 1<br/>Line 2</p><div><span>Item A</span><span>Item B</span></div>&nbsp;End';
  assert.equal(stripHtmlTags(html), 'Line 1 Line 2 Item A Item B End');
  assert.equal(stripHtmlTags(''), '');
});

test('extractAttr extracts double-quoted, single-quoted, and unquoted attributes with entity decoding', () => {
  const attrs = 'class="card-item active" data-title=\'Arts &amp; Crafts\' tabindex=0';
  assert.equal(extractAttr(attrs, 'class'), 'card-item active');
  assert.equal(extractAttr(attrs, 'DATA-TITLE'), 'Arts & Crafts');
  assert.equal(extractAttr(attrs, 'tabindex'), '0');
  assert.equal(extractAttr(attrs, 'href'), null);
  assert.equal(extractAttr('', 'class'), null);
});

test('findBalancedTagEnd tracks nested tags and handles void tags', () => {
  const html = '<div class="outer"><div class="inner">Hi</div><br>Done</div><span>After</span>';
  const contentStart = '<div class="outer">'.length;
  const { innerEnd, outerEnd } = findBalancedTagEnd(html, 'div', contentStart);
  assert.equal(html.slice(contentStart, innerEnd), '<div class="inner">Hi</div><br>Done');
  assert.equal(html.slice(outerEnd), '<span>After</span>');

  const voidResult = findBalancedTagEnd('<img src="a.png">Next', 'img', 17);
  assert.deepEqual(voidResult, { innerEnd: 17, outerEnd: 17 });
});

test('hasClassToken matches exact whitespace-delimited class tokens case-insensitively', () => {
  assert.equal(hasClassToken('event-title featured', 'event-title'), true);
  assert.equal(hasClassToken('Event-Title Featured', ['other', 'event-title']), true);
  assert.equal(hasClassToken('event-title-sub', 'event-title'), false);
  assert.equal(hasClassToken('', 'event-title'), false);
});

test('extractFirstElementByClass and extractTextByClassOrder extract balanced elements and text by priority', () => {
  const html = `
    <img class="event-title" src="x.png">
    <div class="summary"><div class="nested">Nested <b>summary</b></div></div>
    <h2 class="event-title">Community <span>Yoga</span></h2>
  `;
  const el = extractFirstElementByClass(html, ['event-title']);
  assert.equal(el.tagName, 'h2');
  assert.equal(el.innerHtml, 'Community <span>Yoga</span>');

  assert.equal(extractTextByClassOrder(html, ['missing', 'event-title', 'summary']), 'Community Yoga');
  assert.equal(extractTextByClassOrder(html, ['summary', 'event-title']), 'Nested summary');
  assert.equal(extractTextByClassOrder(html, ['missing']), '');
});

test('resolveUrl resolves relative URLs against currentUrl or baseUrl and rejects non-navigable links', () => {
  assert.equal(resolveUrl('https://example.wa.gov.au', '/events/yoga?a=1&amp;b=2'), 'https://example.wa.gov.au/events/yoga?a=1&b=2');
  assert.equal(resolveUrl('https://example.wa.gov.au', 'page-2', 'https://example.wa.gov.au/events/'), 'https://example.wa.gov.au/events/page-2');
  assert.equal(resolveUrl('https://example.wa.gov.au', '#section'), null);
  assert.equal(resolveUrl('https://example.wa.gov.au', 'javascript:void(0)'), null);
  assert.equal(resolveUrl('https://example.wa.gov.au', 'mailto:test@example.com'), null);
  assert.equal(resolveUrl('https://example.wa.gov.au', 'tel:0899990000'), null);
  assert.equal(resolveUrl('https://example.wa.gov.au', '/cdn-cgi/l/email-protection#abc'), null);
  assert.equal(resolveUrl('https://example.wa.gov.au', ''), null);
});

test('normalizeTimeRangeText infers start meridiem for shorthand time ranges', () => {
  assert.equal(normalizeTimeRangeText('4 - 8pm'), '4pm - 8pm');
  assert.equal(normalizeTimeRangeText('10:00 - 11:00am'), '10:00am - 11:00am');
  assert.equal(normalizeTimeRangeText('11:00 - 2:00pm'), '11:00am - 2:00pm');
  assert.equal(normalizeTimeRangeText('12:00 - 2:00pm'), '12:00pm - 2:00pm');
  assert.equal(normalizeTimeRangeText('9 - 12pm'), '9am - 12pm');
  assert.equal(normalizeTimeRangeText('4pm - 8pm'), '4pm - 8pm');
  assert.equal(normalizeTimeRangeText(''), '');
});
