// parse.js -- a dependency-free Markdown renderer for Node.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 returns for the
// same input with marked's default options (gfm on, breaks off, pedantic off,
// async off). The grammar and token shapes follow marked's MIT-licensed source
// (Copyright (c) 2018+, MarkedJS; Copyright (c) 2011-2018, Christopher Jeffrey);
// the implementation here is specialized to those defaults: no option object,
// no extension points, no pedantic grammar, and hot paths written without the
// class and dispatch layers that marked needs for configurability. See NOTICE.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_TABLE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeOne = (ch) => ESCAPE_TABLE[ch];

const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(text, encode) {
  if (encode) {
    if (escapeTest.test(text)) return text.replace(escapeReplace, escapeOne);
  } else if (escapeTestNoEncode.test(text)) {
    return text.replace(escapeReplaceNoEncode, escapeOne);
  }
  return text;
}

const numericReference = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericReferenceOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericReferences(text) {
  if (text.indexOf('&') === -1 || !numericReference.test(text)) return text;
  // A decoded character must not join its neighbours into a new reference, so
  // every remaining `&` that cannot start one is escaped on the same pass.
  return text.replace(numericReferenceOrAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '\uFFFD';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const uriSafe = /^[A-Za-z0-9!#$&'()*+,\-./:;=?@_~%]*$/;

function cleanUrl(href) {
  // encodeURI leaves these characters alone, and `%` round-trips through the
  // replacement below, so the common URL costs no encoding call at all.
  if (uriSafe.test(href)) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const findPipe = /\|/g;
const splitPipe = / \|/;
const slashPipe = /\\\|/g;

function splitCells(tableRow, count) {
  // Every unescaped pipe gets a space in front of it, so a split on " |" can
  // tell it from one that is escaped.
  const row = tableRow.replace(findPipe, (match, offset, str) => {
    let escaped = false;
    for (let curr = offset - 1; curr >= 0 && str[curr] === '\\'; curr--) {
      escaped = !escaped;
    }
    return escaped ? '|' : ' |';
  });
  const cells = row.split(splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(slashPipe, '|');
  }
  return cells;
}

// Remove trailing `c` characters, like str.replace(/c*$/, '').
function rtrimChars(str, c) {
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === c.charCodeAt(0)) end--;
  return str.slice(0, end);
}

const blankLineTest = /^[ \t]*$/;

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && blankLineTest.test(lines[end])) end--;
  // A single trailing blank line is kept.
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

const spacesTest = /\s+/g;

function normalizeLabel(label) {
  // CommonMark case fold: a round trip through upper case maps e.g. ẞ to SS.
  return label.trim().replace(spacesTest, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') i++;
    else if (ch === b[0]) level++;
    else if (ch === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

// Code-point count of a string without materialising an array of characters.
function codePointLength(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    n++;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return n;
}

// Last code point of str.slice(start, end), or '' when that slice is empty.
function lastCodePoint(str, start, end) {
  if (end <= start) return '';
  let i = end - 1;
  const c = str.charCodeAt(i);
  if (c >= 0xdc00 && c <= 0xdfff && i > start) {
    const p = str.charCodeAt(i - 1);
    if (p >= 0xd800 && p <= 0xdbff) return str.slice(i - 1, i + 1);
  }
  return str[i];
}

function firstCodePointLength(str) {
  const c = str.charCodeAt(0);
  if (c >= 0xd800 && c <= 0xdbff && str.length > 1) {
    const d = str.charCodeAt(1);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

const tagNames = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const B = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  text: /^[^\n]+/,
  lheading: /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
  blockquote: /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*))|[^\n]*)(?:\n|$))+/,
  html: /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))/i,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  paragraph: /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/,
};

const I = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  link: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\([ \t\n]*(<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\)))(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)))?[ \t\n]*\)/,
  reflink: /^!?\[((?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n])+)\]/,
  nolink: /^!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n])+)\](?:\[\])?/,
  reflinkSearch: /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu,
  emStrongRDelimUnd: /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu,
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu,
  url: /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
};

// Regexes whose allowed indent depends on a list item's content column.
const cachedIndent = (build) => {
  const cache = [];
  return (indent) => {
    const slot = indent >= 1 ? Math.min(indent - 1, 3) : 0;
    let regex = cache[slot];
    if (!regex) {
      regex = build(slot);
      cache[slot] = regex;
    }
    return regex;
  };
};

const listItemRegexCache = new Map();
const listItemRegex = (bull) => {
  let regex = listItemRegexCache.get(bull);
  if (!regex) {
    regex = new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
    listItemRegexCache.set(bull, regex);
  }
  return regex;
};
const nextBulletRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}(?:</?(?:${tagNames})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndent((n) => new RegExp(`^ {0,${n}}>`));

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineGlobal: /\n/g,
  tabGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  alphaNumeric: /[\p{L}\p{N}]/u,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// ---------------------------------------------------------------------------
// Lexer state
// ---------------------------------------------------------------------------

function newLexer() {
  return {
    tokens: [],
    // Link definitions are only consulted while lexing, never rendered.
    links: Object.create(null),
    queue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
    // One closer hint frame per inline pass, innermost last.
    hints: [],
  };
}

function inline(lex, src, tokens = []) {
  lex.queue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Block tokenizer
// ---------------------------------------------------------------------------

function tokenizeSpace(src) {
  const cap = B.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokenizeCode(src) {
  const cap = B.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return { type: 'code', raw, text: raw.replace(other.codeRemoveIndent, '') };
  }
}

function indentCodeCompensation(raw, text) {
  const match = raw.match(other.indentCodeCompensation);
  if (match === null) return text;
  const indentToCode = match[1];
  return text.split('\n').map((node) => {
    const leading = node.match(other.beginningSpace);
    if (leading === null) return node;
    return node.slice(Math.min(leading[0].length, indentToCode.length));
  }).join('\n');
}

function tokenizeFences(src) {
  const cap = B.fences.exec(src);
  if (cap) {
    return {
      type: 'code',
      raw: cap[0],
      lang: cap[2] ? cap[2].trim().replace(I.anyPunctuation, '$1') : cap[2],
      text: indentCodeCompensation(cap[0], cap[3] || ''),
    };
  }
}

function tokenizeHeading(lex, src) {
  const cap = B.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (other.endingHash.test(text)) {
      const stripped = rtrimChars(text, '#');
      if (!stripped || other.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: rtrimChars(cap[0], '\n'), depth: cap[1].length, text, tokens: inline(lex, text) };
  }
}

function tokenizeHr(src) {
  const cap = B.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrimChars(cap[0], '\n') };
}

function tokenizeBlockquote(lex, src) {
  const cap = B.blockquote.exec(src);
  if (!cap) return;

  let lines = rtrimChars(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (other.blockquoteStart.test(line)) {
        currentLines.push(line);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(line);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(other.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;

    // Blockquote content is parsed as top-level tokens, and a lazy
    // continuation paragraph merges with the previous one.
    const top = lex.state.top;
    lex.state.top = true;
    blockTokens(lex, currentText, tokens, true);
    lex.state.top = top;

    if (lines.length === 0) break;

    const lastToken = tokens[tokens.length - 1];
    if (!lastToken) continue;

    if (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr'
      || lastToken.type === 'html' || lastToken.type === 'table') {
      break;
    } else if (lastToken.type === 'blockquote') {
      const continuation = lines.join('\n');
      const newText = lastToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newToken = tokenizeBlockquote(lex, newText);
      tokens[tokens.length - 1] = newToken;

      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - lastToken.text.length) + newToken.text;

      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken.type === 'list') {
      const newText = lastToken.raw + '\n' + lines.join('\n');
      const newToken = tokenizeList(lex, newText);
      tokens[tokens.length - 1] = newToken;

      const consumedCount = newToken.raw.length > lastToken.raw.length
        ? newText.slice(lastToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { type: 'blockquote', raw, tokens, text };
}

function tokenizeList(lex, src) {
  let cap = B.list.exec(src);
  if (!cap) return;

  // src is only consumed from the front, so every raw is a slice of listSrc.
  const listSrc = src;
  const taken = () => listSrc.length - src.length;

  let bull = cap[1].trim();
  const ordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered,
    start: ordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  const itemRegex = listItemRegex(ordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`);
  let endsWithBlankLine = false;

  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (B.hr.test(src)) break;

    const itemStart = taken();
    src = src.substring(cap[0].length);

    const firstNewline = cap[2].indexOf('\n');
    const firstLine = firstNewline === -1 ? cap[2] : cap[2].slice(0, firstNewline);
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(other.leadingSpaceTab, (space) => expandTabs(space, bulletIndent));
    const nextNewline = src.indexOf('\n');
    let nextLine = nextNewline === -1 ? src : src.slice(0, nextNewline);
    let blankLine = !line.trim();

    let indent;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && other.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBullet = nextBulletRegex(indent);
      const hr = hrRegex(indent);
      const fencesBegin = fencesBeginRegex(indent);
      const headingBegin = headingBeginRegex(indent);
      const htmlBegin = htmlBeginRegex(indent);
      const blockquoteBegin = blockquoteBeginRegex(indent);

      while (src) {
        const newline = src.indexOf('\n');
        const rawLine = newline === -1 ? src : src.slice(0, newline);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.indexOf('\t') === -1
          ? nextLine
          : nextLine.replace(other.leadingSpaceTab, (space) => expandTabs(space));

        // Only a run of at most `indent` spaces followed by one of these
        // characters can match any of the block-start regexes below.
        let p = 0;
        while (p <= indent && nextLine.charCodeAt(p) === 32) p++;
        const first = p <= indent ? nextLine.charCodeAt(p) : -1;
        if (first === 96 || first === 126) {
          if (fencesBegin.test(nextLine)) break;
        } else if (first === 35) {
          if (headingBegin.test(nextLine)) break;
        } else if (first === 60) {
          if (htmlBegin.test(nextLine)) break;
        } else if (first === 62) {
          if (blockquoteBegin.test(nextLine)) break;
        } else if (first === 42 || first === 43 || first === 45 || (first >= 48 && first <= 57)) {
          if (nextBullet.test(nextLine)) break;
          if ((first === 42 || first === 45) && hr.test(nextLine)) break;
        } else if (first === 95) {
          if (hr.test(nextLine)) break;
        }

        const blank = !nextLine.trim();
        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || blank) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(other.tabGlobal, '    ').search(other.nonSpaceChar) >= 4) break;
          if (fencesBegin.test(line)) break;
          if (headingBegin.test(line)) break;
          if (htmlBegin.test(line)) break;
          if (hr.test(line)) break;

          // A lazy continuation line may look like a setext underline once the
          // list indentation is gone; keep it in the paragraph instead.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && B.lheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = blank;
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }

    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }

    list.items.push({
      type: 'list_item',
      raw,
      task: other.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item children are tokenized here because list looseness depends on every
  // item's trailing blank lines; checkboxes are placed afterwards.
  for (const item of list.items) {
    lex.state.top = false;
    item.tokens = blockTokens(lex, item.text, []);

    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      list.loose = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
    }
  }

  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && itemToken && (itemToken.type === 'text' || itemToken.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
      for (let i = lex.queue.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(lex.queue[i].src)) {
          lex.queue[i].src = lex.queue[i].src.replace(other.listReplaceTask, '');
          break;
        }
      }

      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkbox = {
          type: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkbox.checked;
        if (list.loose) {
          const first = item.tokens[0];
          if (first && (first.type === 'paragraph' || first.type === 'text') && first.tokens) {
            first.raw = checkbox.raw + first.raw;
            first.text = checkbox.raw + first.text;
            first.tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }

  return list;
}

function tokenizeHtml(src) {
  const cap = B.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokenizeDef(src) {
  const cap = B.def.exec(src);
  if (!cap) return;
  if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;

  const tag = normalizeLabel(cap[1]);
  const href = cap[2]
    ? cap[2].replace(other.hrefBrackets, '$1').replace(I.anyPunctuation, '$1')
    : '';
  const title = cap[3]
    ? cap[3].substring(1, cap[3].length - 1).replace(I.anyPunctuation, '$1')
    : cap[3];
  return { type: 'def', tag, raw: rtrimChars(cap[0], '\n'), href, title };
}

const tableDelimMaybe = /^ {0,3}[|: -]*-[|: -]*$/;

function tokenizeTable(lex, src) {
  // A table delimiter row uses only spaces, pipes, colons and dashes, and must
  // follow the header line immediately; check that cheaply before the full
  // table grammar (whose tag alternation is expensive).
  const headerEnd = src.indexOf('\n');
  if (headerEnd === -1) return;
  const rowEnd = src.indexOf('\n', headerEnd + 1);
  const delimiterRow = src.slice(headerEnd + 1, rowEnd === -1 ? src.length : rowEnd);
  if (!tableDelimMaybe.test(delimiterRow) || !other.tableDelimiter.test(delimiterRow)) return;

  const cap = B.table.exec(src);
  if (!cap || !other.tableDelimiter.test(cap[2])) return;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim()
    ? cap[3].replace(other.tableRowBlankLine, '').split('\n')
    : [];

  const token = { type: 'table', raw: rtrimChars(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return;

  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) token.align.push('right');
    else if (other.tableAlignCenter.test(align)) token.align.push('center');
    else if (other.tableAlignLeft.test(align)) token.align.push('left');
    else token.align.push(null);
  }

  for (let i = 0; i < headers.length; i++) {
    token.header.push({
      text: headers[i],
      tokens: inline(lex, headers[i]),
      header: true,
      align: token.align[i],
    });
  }

  for (const row of rows) {
    const cells = splitCells(row, token.header.length);
    const out = [];
    for (let i = 0; i < cells.length; i++) {
      out.push({
        text: cells[i],
        tokens: inline(lex, cells[i]),
        header: false,
        align: token.align[i],
      });
    }
    token.rows.push(out);
  }

  return token;
}

const setextMaybe = /\n {0,3}[=-]/;

function tokenizeLheading(lex, src) {
  // A setext underline is the only way lheading can match; the full grammar is
  // a large alternation, so look for that underline first.
  if (!setextMaybe.test(src)) return;
  const cap = B.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrimChars(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: inline(lex, text),
    };
  }
}

function tokenizeParagraph(lex, src) {
  const cap = B.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n'
      ? cap[1].slice(0, -1)
      : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: inline(lex, text) };
  }
}

function tokenizeText(lex, src) {
  const cap = B.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: inline(lex, cap[0]) };
  }
}

function blockTokens(lex, src, tokens, lastParagraphClipped = false) {
  {
    let srcLength = Infinity;

    while (src) {
      if (src.length < srcLength) {
        srcLength = src.length;
      } else {
        // The loop must consume input; a stuck position is a bug in the grammar.
        src = src.substring(1);
        continue;
      }

      let token = tokenizeSpace(src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
        else tokens.push(token);
        continue;
      }

      token = tokenizeCode(src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lex.queue[lex.queue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      token = tokenizeFences(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeHeading(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeHr(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeBlockquote(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeList(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeHtml(src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeDef(src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (lastToken && (lastToken.type === 'paragraph' || lastToken.type === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          lex.queue[lex.queue.length - 1].src = lastToken.text;
        } else {
          if (!lex.links[token.tag]) lex.links[token.tag] = { href: token.href, title: token.title };
          tokens.push(token);
        }
        continue;
      }

      token = tokenizeTable(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      token = tokenizeLheading(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }

      if (lex.state.top && (token = tokenizeParagraph(lex, src))) {
        const lastToken = tokens[tokens.length - 1];
        if (lastParagraphClipped && lastToken && lastToken.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lex.queue.pop();
          lex.queue[lex.queue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }

      token = tokenizeText(lex, src);
      if (token) {
        src = src.substring(token.raw.length);
        const lastToken = tokens[tokens.length - 1];
        if (lastToken && lastToken.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lex.queue.pop();
          lex.queue[lex.queue.length - 1].src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // Nothing matched: drop one character so the loop always advances.
      src = src.substring(1);
    }

    lex.state.top = true;
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Inline tokenizer
// ---------------------------------------------------------------------------

function scanCloserHints(src) {
  const last = { '*': -1, _: -1 };
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { src, em: last, del };
}

function cachedEmCloser(lex, maskedSrc, delim) {
  const frame = lex.hints[lex.hints.length - 1];
  if (frame && frame.src === maskedSrc) return frame.em[delim];
  return scanCloserHints(maskedSrc).em[delim];
}

function cachedDelCloser(lex, maskedSrc) {
  const frame = lex.hints[lex.hints.length - 1];
  if (frame && frame.src === maskedSrc) return frame.del;
  return scanCloserHints(maskedSrc).del;
}

function linkInText(lex, text) {
  if (!text.includes('[')) return false;

  for (const match of text.matchAll(I.blockSkip)) {
    // blockSkip also matches code spans and raw HTML; only a link counts, and
    // the `!` of an image is left out of the match.
    if (I.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }

  for (const match of text.matchAll(I.reflinkSearch)) {
    const m0 = match[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(lex.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(lex, m0.slice(1, refStart - 1))) continue;
    return true;
  }

  return false;
}

function maskSource(lex, src) {
  // None of the masks can match without one of these characters.
  if (src.indexOf('\\') === -1 && src.indexOf('`') === -1
    && src.indexOf('[') === -1 && src.indexOf('<') === -1) return src;
  let maskedSrc = src;

  if (src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(lex.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(lex, text)) {
          return '[' + text.replace(I.reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(I.reflinkSearch, maskReflink);
  }

  // Every mask keeps the length of what it replaces, because emStrong and del
  // line maskedSrc up with src by slicing from the end.
  if (maskedSrc.indexOf('`') !== -1 || maskedSrc.indexOf('\\') !== -1) {
    maskedSrc = maskedSrc.replace(I.anyPunctuationOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }

  // blockSkip only covers bracketed links, code spans and raw HTML tags.
  if (maskedSrc.indexOf('[') !== -1 || maskedSrc.indexOf('`') !== -1 || maskedSrc.indexOf('<') !== -1) {
    maskedSrc = maskedSrc.replace(I.blockSkip, (m0, _link, context) => {
      const offset = context ? context.length : 0;
      return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

const EMPTY_HINTS = { src: '', em: { '*': -1, _: -1 }, del: -1 };

function inlineTokens(lex, src, tokens = []) {
  const outerParenPossible = lex.state.linkParenPossible;
  lex.state.linkParenPossible = outerParenPossible && src.includes(')');
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  if (!needsMask) {
    const result = tokenizeInlines(lex, src, src, tokens);
    lex.state.linkParenPossible = outerParenPossible;
    return result;
  }
  const maskedSrc = maskSource(lex, src);

  const frame = scanCloserHints(maskedSrc);
  lex.hints.push(frame);
  const result = tokenizeInlines(lex, src, maskedSrc, tokens);
  lex.hints.pop();
  lex.state.linkParenPossible = outerParenPossible;
  return result;
}

function tokenizeInlines(lex, src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;

  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      src = src.substring(1);
      continue;
    }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    // Dispatch on the next character: every tokenizer below is anchored at ^,
    // so most of them cannot match unless the first character agrees.
    const c = src.charCodeAt(0);
    let token;
    let merge = 0;
    switch (c) {
      case 92: // backslash
        token = tokenizeEscape(src);
        if (!token) token = tokenizeBr(src);
        break;
      case 60: // <
        token = tokenizeTag(lex, src);
        if (!token) token = tokenizeAutolink(src);
        break;
      case 91: // [
        token = tokenizeLink(lex, src);
        if (!token) {
          token = tokenizeReflink(lex, src);
          merge = 1;
        }
        break;
      case 33: // !
        if (src.charCodeAt(1) === 91) {
          token = tokenizeLink(lex, src);
          if (!token) {
            token = tokenizeReflink(lex, src);
            merge = 1;
          }
        }
        break;
      case 42: // *
      case 95: // _
        token = tokenizeEmStrong(lex, src, maskedSrc, prevChar);
        break;
      case 96: // `
        token = tokenizeCodespan(src);
        break;
      case 126: // ~
        token = tokenizeDel(lex, src, maskedSrc, prevChar);
        break;
      case 32: // space
        token = tokenizeBr(src);
        break;
      default:
        if (!lex.state.inLink) token = tokenizeUrl(src);
        break;
    }

    if (!token) {
      token = tokenizeInlineText(lex, src);
      if (!token) {
        src = src.substring(1);
        continue;
      }
      merge = 2;
    }

    src = src.substring(token.raw.length);
    if (merge === 2) {
      if (token.raw.slice(-1) !== '_') prevChar = token.raw.slice(-1);
      keepPrevChar = true;
    }
    const lastToken = tokens[tokens.length - 1];
    if (merge !== 0 && token.type === 'text' && lastToken && lastToken.type === 'text') {
      lastToken.raw += token.raw;
      lastToken.text += token.text;
    } else {
      tokens.push(token);
    }
    continue;
  }

  return tokens;
}

function tokenizeEscape(src) {
  const cap = I.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokenizeTag(lex, src) {
  const cap = I.tag.exec(src);
  if (!cap) return;

  if (!lex.state.inLink && other.startATag.test(cap[0])) lex.state.inLink = true;
  else if (lex.state.inLink && other.endATag.test(cap[0])) lex.state.inLink = false;

  if (!lex.state.inRawBlock && other.startPreScriptTag.test(cap[0])) lex.state.inRawBlock = true;
  else if (lex.state.inRawBlock && other.endPreScriptTag.test(cap[0])) lex.state.inRawBlock = false;

  return {
    type: 'html',
    raw: cap[0],
    inLink: lex.state.inLink,
    inRawBlock: lex.state.inRawBlock,
    block: false,
    text: cap[0],
  };
}

function labelEndsInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;

  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;

    const tokenSrc = src.slice(labelStart + i);
    const token = I.tag.exec(tokenSrc) || I.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(lex, cap, link, raw) {
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = lex.state.inLink;
  const outerLinkEmitted = lex.state.linkEmitted;
  const outerInRawBlock = lex.state.inRawBlock;
  lex.state.inLink = true;
  lex.state.linkEmitted = false;
  const tokens = inlineTokens(lex, text);
  const textHasLink = lex.state.linkEmitted;
  lex.state.linkEmitted = outerLinkEmitted;
  lex.state.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain links; fall back so the inner one is kept.
    if (textHasLink) {
      lex.state.inRawBlock = outerInRawBlock;
      return;
    }
    lex.state.linkEmitted = true;
  }

  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: link.href,
    title: link.title || null,
    text,
    tokens,
  };
}

function tokenizeLink(lex, src) {
  // The link regex backtracks quadratically over unterminated links; without a
  // ')' anywhere ahead it cannot match.
  if (lex.state.linkParenPossible === false) return;

  const cap = I.link.exec(src);
  if (!cap) return;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndsInsideToken(src, cap[1], labelStart)) return;

  const trimmedUrl = cap[2].trim();
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) return;
    const withoutSlashes = rtrimChars(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - withoutSlashes.length) % 2 === 0) return;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }

  const unescaped = rtrimChars(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return;

  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) href = href.slice(1, -1);

  return outputLink(lex, cap, {
    href: href ? href.replace(I.anyPunctuation, '$1') : href,
    title: title ? title.replace(I.anyPunctuation, '$1') : title,
  }, cap[0]);
}

function tokenizeReflink(lex, src) {
  let cap = I.reflink.exec(src);
  if (!cap) cap = I.nolink.exec(src);
  if (!cap) return;

  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelEndsInsideToken(src, cap[1], labelStart)) return;

  const link = lex.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { type: 'text', raw: text, text };
  }
  return outputLink(lex, cap, link, cap[0]);
}

function tokenizeEmStrong(lex, src, maskedSrc, prevChar) {
  let match = I.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;

  const delimChar = match[0][0];
  // A mid-run opener (say the second star of an unmatched `**`) may only pair
  // with a delimiter that can only close, so it cannot steal a later opener.
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;

  const runPrevChar = lastCodePoint(maskedSrc, Math.max(0, runStart - 2), runStart);
  // The other delimiter character counts as punctuation here (`_**a*`).
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I.punctuation.exec(prevChar);

  // `_` cannot open inside a word.
  if (match[4] && other.alphaNumeric.test(prevChar)) return;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = codePointLength(match[0]) - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;

    const endReg = delimChar === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
    const lastCloser = cachedEmCloser(lex, maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastCloser < windowStart) return;

    const windowSrc = maskedSrc.slice(lLength - src.length);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(windowSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;

      rLength = codePointLength(rDelim);

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      // Remove extra delimiter characters: *a*** -> *a*.
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = firstCodePointLength(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(lex, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(lex, text) };
    }
  }
}

function tokenizeCodespan(src) {
  const cap = I.code.exec(src);
  if (cap) {
    let text = cap[2].replace(other.newLineGlobal, ' ');
    const hasNonSpace = other.nonSpaceChar.test(text);
    const padded = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokenizeBr(src) {
  const cap = I.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokenizeDel(lex, src, maskedSrc, prevChar) {
  let match = I.delLDelim.exec(src);
  if (!match) return;

  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar)) {
    const lLength = codePointLength(match[0]) - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;

    const endReg = I.delRDelim;
    const lastCloser = cachedDelCloser(lex, maskedSrc);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastCloser < windowStart) return;

    const windowSrc = maskedSrc.slice(lLength - src.length);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(windowSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = codePointLength(rDelim);
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = firstCodePointLength(match[0]);
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(lex, text) };
    }
  }
}

function tokenizeAutolink(src) {
  const cap = I.autolink.exec(src);
  if (cap) {
    const text = cap[1];
    const href = cap[2] === '@' ? 'mailto:' + text : text;
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokenizeUrl(src) {
  const cap = I.url.exec(src);
  if (!cap) return;

  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let previous;
    do {
      previous = cap[0];
      cap[0] = I.backpedal.exec(cap[0])?.[0] ?? '';
    } while (previous !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }

  return {
    type: 'link',
    raw: cap[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: 'text', raw: text, text }],
  };
}

// The earliest position at which marked's inline text grammar can stop: any of
// its delimiter characters, an autolink protocol, or a bare `www.` at a word
// boundary. A plain-text run can be cut there without running the large
// I.text grammar over it.
const textStop = /[\\<!\[`*~_]|[hH][tT][tT][pP]|[fF][tT][tT][pP]:\/\/|(?<![^\s*_~(])www\.|(?= {2,}\n)/;

function tokenizeInlineText(lex, src) {
  const stop = textStop.exec(src);
  const end = stop ? stop.index : src.length;

  if (end > 0) {
    // The email, mailto: and xmpp: boundaries need a little more context; let
    // the regex handle those rare cases.
    const window = end + 8 >= src.length ? src : src.slice(0, end + 8);
    if (window.indexOf('@') === -1 && window.indexOf('mailto:') === -1 && window.indexOf('xmpp:') === -1) {
      const raw = end === src.length ? src : src.slice(0, end);
      const escaped = lex.state.inRawBlock;
      return {
        type: 'text',
        raw,
        text: escaped ? raw : decodeNumericReferences(raw),
        escaped,
      };
    }
  }

  const cap = I.text.exec(src);
  if (cap) {
    const escaped = lex.state.inRawBlock;
    return {
      type: 'text',
      raw: cap[0],
      text: escaped ? cap[0] : decodeNumericReferences(cap[0]),
      escaped,
    };
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function renderInlineTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'text':
      case 'escape':
        out += token.escaped ? token.text : escapeHtml(token.text);
        break;
      case 'html':
        out += token.text;
        break;
      case 'link':
        out += renderLink(token);
        break;
      case 'image':
        out += renderImage(token);
        break;
      case 'strong':
        out += '<strong>' + renderInlineTokens(token.tokens) + '</strong>';
        break;
      case 'em':
        out += '<em>' + renderInlineTokens(token.tokens) + '</em>';
        break;
      case 'del':
        out += '<del>' + renderInlineTokens(token.tokens) + '</del>';
        break;
      case 'codespan':
        out += '<code>' + escapeHtml(token.text, true) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'checkbox':
        out += token.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        break;
      default:
        break;
    }
  }
  return out;
}

// Only the textual part of inline tokens, for an image's alt attribute.
function renderInlineText(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'text':
      case 'escape':
      case 'codespan':
      case 'html':
        out += token.text;
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineText(token.tokens) : token.text;
        break;
      case 'checkbox':
        out += token.raw;
        break;
      default:
        break;
    }
  }
  return out;
}

function renderLink(token) {
  const text = token.autolink ? escapeHtml(token.text, true) : renderInlineTokens(token.tokens);
  const href = cleanUrl(token.href);
  if (href === null) return text;

  let out = '<a href="' + escapeHtml(href, !!token.autolink) + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  return out + '>' + text + '</a>';
}

function renderImage(token) {
  const text = token.tokens ? renderInlineText(token.tokens) : token.text;
  const href = cleanUrl(token.href);
  if (href === null) return escapeHtml(text);

  let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text) + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  return out + '>';
}

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  let code = '';
  if (token.text) code = token.text.replace(other.endingNewline, '') + '\n';

  if (!langString) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString)
    + '">' + escapeHtml(code, true) + '</code></pre>\n';
}

function renderTable(token) {
  let header = '';
  for (let i = 0; i < token.header.length; i++) header += renderTableCell(token.header[i]);
  header = '<tr>\n' + header + '</tr>\n';

  let body = '';
  for (let r = 0; r < token.rows.length; r++) {
    const row = token.rows[r];
    let cells = '';
    for (let c = 0; c < row.length; c++) cells += renderTableCell(row[c]);
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';

  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderTableCell(cell) {
  const type = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return open + renderInlineTokens(cell.tokens) + `</${type}>\n`;
}

function renderList(token) {
  let body = '';
  for (let i = 0; i < token.items.length; i++) {
    body += '<li>' + renderBlocks(token.items[i].tokens) + '</li>\n';
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = token.ordered && token.start !== 1 ? ' start="' + token.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlocks(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading':
        out += `<h${token.depth}>` + renderInlineTokens(token.tokens) + `</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token);
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(token.tokens) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'paragraph':
        out += '<p>' + renderInlineTokens(token.tokens) + '</p>\n';
        break;
      case 'text':
        out += token.tokens ? renderInlineTokens(token.tokens) : escapeHtml(token.text);
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'checkbox':
        out += token.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
        break;
      default:
        // space, def and anything else render nothing
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render `markdown` exactly as marked 18.1.3 does with default options. */
export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n|\r/g, '\n');
  const lex = newLexer();

  blockTokens(lex, src, lex.tokens);

  for (let i = 0; i < lex.queue.length; i++) {
    const next = lex.queue[i];
    // An inline <pre>, <code>, <kbd> or <script> may be left open inside one
    // block; that must not leak into the next block's text escaping.
    lex.state.inRawBlock = false;
    inlineTokens(lex, next.src, next.tokens);
  }
  lex.queue = [];

  return renderBlocks(lex.tokens);
}
