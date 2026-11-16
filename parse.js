/**
 * Fast drop-in replacement for marked 18.1.3 (default options, GFM on).
 *
 * parse(markdown) returns exactly the HTML that marked.parse(markdown)
 * returns with marked's defaults, for every input — but faster.
 *
 * How it works: this file re-implements marked's own parsing pipeline
 * (block lexer, inline lexer, renderer) with the same matching rules and
 * the same output, but renders straight to HTML strings instead of
 * building token objects and walking them again, and replaces the hottest
 * regular expressions with equivalent manual scans. The grammar below is
 * marked's GFM grammar; where a construct falls outside what this file
 * implements, parse() falls back to marked itself.
 *
 * marked 18.1.3 is vendored under vendor/marked/ (MIT, see
 * vendor/marked/LICENSE and vendor/marked/NOTICE) and used only as that
 * fallback. This file is otherwise written from scratch for this entry.
 */

import { marked } from './vendor/marked/marked.esm.js';

/* ------------------------------------------------------------------ */
/* Grammar: marked 18.1.3's GFM block and inline rules (defaults).    */
/* ------------------------------------------------------------------ */

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const _punctuation = /[\p{P}\p{S}]/u;
const _punctuationOrSpace = /[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpace = /[^\s\p{P}\p{S}]/u;
// GFM allows ~ inside strong and em for strikethrough
const _punctuationGfmStrongEm = /(?!~)[\p{P}\p{S}]/u;
const _punctuationOrSpaceGfmStrongEm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctuationOrSpaceGfmStrongEm = /(?:[^\s\p{P}\p{S}]|~)/u;

function edit(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  const obj = {
    replace: (name, val) => {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex: () => new RegExp(source, opt),
  };
  return obj;
}

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
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
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: (indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hrRegex: (indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fencesBeginRegex: (indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`),
  headingBeginRegex: (indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`),
  htmlBeginRegex: (indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  blockquoteBeginRegex: (indent) => new RegExp(`^ {0,${indent}}>`),
};

const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const blockCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const hrRe = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const headingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const bulletRe = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const listRe = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bulletRe).getRegex();
const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const defRe = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', _blockLabel)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const htmlRe = edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', _comment)
  .replace('tag', _tag)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const gfmTableRe = edit(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', hrRe)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', _tag)
  .getRegex();
// Blockquote: a run of lines starting with `>` plus lazy paragraph lines.
const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', edit(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .replace('hr', hrRe)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', _tag)
    .getRegex())
  .getRegex();

/* Inline grammar (GFM). */
const escapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineCodeRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const brRe = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const _inlineComment = edit(_comment).replace('(?:-->|$)', '-->').getRegex();
const tagRe = edit(
  '^comment'
    + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
    + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
    + '|^<\\?[\\s\\S]*?\\?>'
    + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
    + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', _inlineComment)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const autolinkRe = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const linkRe = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', _inlineLabel)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const reflinkRe = edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', _inlineLabel)
  .replace('ref', _blockLabel)
  .getRegex();
const nolinkRe = edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', _blockLabel)
  .getRegex();
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .replace('brackets', _inlineLabelBrackets)
  .getRegex();
const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', _boundedInlineLabel)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', _boundedBlockLabel)
    .getRegex())
  .getRegex();
const _caseInsensitiveProtocol = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const _extendedEmail = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const _extendedEmailProtocol = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, _extendedEmail)
  .getRegex();
const urlRe = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', _extendedEmailProtocol)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const delRe = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const emStrongLDelimCore = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const emStrongLDelimRe = edit(emStrongLDelimCore, 'u')
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();
const emStrongRDelimAstCore =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)' // Skip orphan inside strong
  + '|[^*]+(?=[^*])' // Consume to delim
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)' // (1) #*** can only be a Right Delimiter
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)' // (2) a***#, a*** can only be a Right Delimiter
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)' // (3) #***a, ***a can only be Left Delimiter
  + '|[\\s](\\*+)(?!\\*)(?=punct)' // (4) ***# can only be Left Delimiter
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)' // (5) #***# can be either Left or Right Delimiter
  + '|notPunctSpace(\\*+)(?=notPunctSpace)'; // (6) a***a can be either Left or Right Delimiter
const emStrongRDelimAstRe = edit(emStrongRDelimAstCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpaceGfmStrongEm)
  .replace(/punctSpace/g, _punctuationOrSpaceGfmStrongEm)
  .replace(/punct/g, _punctuationGfmStrongEm)
  .getRegex();
const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)' // Skip orphan inside strong
  + '|[^_]+(?=[^_])' // Consume to delim
  + '|(?!_)punct(_+)(?=[\\s]|$)' // (1) #___ can only be a Right Delimiter
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)' // (2) a___#, a___ can only be a Right Delimiter
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)' // (3) #___a, ___a can only be Left Delimiter
  + '|[\\s](_+)(?!_)(?=punct)' // (4) ___# can only be Left Delimiter
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu') // (5) #___# can be either Left or Right Delimiter
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();
const delLDelimRe = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, _punctuation)
  .getRegex();
const delRDelimCore =
  '^[^~]+(?=[^~])' // Consume to delim
  + '|(?!~)punct(~~?)(?=[\\s]|$)' // (1) #~~ can only be a Right Delimiter
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)' // (2) a~~#, a~~ can only be a Right Delimiter
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)' // (3) #~~a, ~~a can only be Left Delimiter
  + '|[\\s](~~?)(?!~)(?=punct)' // (4) ~~# can only be Left Delimiter
  + '|(?!~)punct(~~?)(?!~)(?=punct)' // (5) #~~# can be either Left or Right Delimiter
  + '|notPunctSpace(~~?)(?=notPunctSpace)'; // (6) a~~a can be either Left or Right Delimiter
const delRDelimRe = edit(delRDelimCore, 'gu')
  .replace(/notPunctSpace/g, _notPunctuationOrSpace)
  .replace(/punctSpace/g, _punctuationOrSpace)
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuationRe = edit(/\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const anyPunctuationOutsideCodeRe = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
  .replace(/punct/g, _punctuation)
  .getRegex();
const punctuationRe = edit(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, _punctuationOrSpace).getRegex();
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const textRe = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', _caseInsensitiveProtocol)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const escapeReplacements = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(html, encode) {
  if (encode) {
    if (other.escapeTest.test(html)) return html.replace(other.escapeReplace, (ch) => escapeReplacements[ch]);
  } else if (other.escapeTestNoEncode.test(html)) {
    return html.replace(other.escapeReplaceNoEncode, (ch) => escapeReplacements[ch]);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(other.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  return cells;
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

/* ------------------------------------------------------------------ */
/* Inline engine: marked's inline lexer, rendering straight to HTML.  */
/* `plain` mode renders the TextRenderer form (image alt text).        */
/* ------------------------------------------------------------------ */

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = inlineCodeRe.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = tagRe.exec(tokenSrc) || autolinkRe.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

const closerRunRe = /([*_~])\1*/g;

/** Last position where a `*`/`_`/`~` run starts with a non-space char
 * before it, per delimiter char. Equivalent to the old char-by-char
 * scan, but the regex engine finds the runs. */
function scanCloserHints(src) {
  let ast = -1, und = -1, del = -1;
  closerRunRe.lastIndex = 0;
  let m;
  while ((m = closerRunRe.exec(src)) !== null) {
    const i = m.index;
    const prev = i === 0 ? '\n' : src[i - 1];
    if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f') continue;
    const ch = m[1];
    if (ch === '~') del = i;
    else if (ch === '*') ast = i;
    else und = i;
  }
  return { ast, und, del };
}

class InlineEngine {
  constructor(links) {
    this.links = links;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.run = null;
  }

  linkInText(text) {
    if (!text.includes('[')) return false;
    for (const match of text.matchAll(blockSkipRe)) {
      if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
    }
    for (const match of text.matchAll(reflinkSearchRe)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!' || !Object.hasOwn(this.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
      return true;
    }
    return false;
  }

  maskSrc(src) {
    let maskedSrc = src;
    if (this.links && src.includes('[')) {
      const maskReflink = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(reflinkSearchRe, maskReflink)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      maskedSrc = maskedSrc.replace(reflinkSearchRe, maskReflink);
    }
    if (src.includes('\\') || src.includes('`')) {
      maskedSrc = maskedSrc.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
        if (punct) return '+'.repeat(match0.length);
        if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        return match0;
      });
    }
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      maskedSrc = maskedSrc.replace(blockSkipRe, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }
    return maskedSrc;
  }

  /** Lex inline `src` to HTML (or plain text when `plain`), returning the string. */
  inline(src, plain = false) {
    const prevRun = this.run;
    const hasParen = (prevRun ? prevRun.hasParen : true) && src.includes(')');
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? this.maskSrc(src) : src;
    const run = { src, masked, hasParen, plain, hints: null };
    if (needsMask) run.hints = scanCloserHints(masked);
    this.run = run;
    try {
      return this.tokenizeInlines(src, plain);
    } finally {
      this.run = prevRun;
    }
  }

  tokenizeInlines(src, plain) {
    const out = [];
    const masked = this.run.masked;
    let pos = 0;
    let prevChar = '';
    let keepPrevChar = false;
    let guard = src.length + 1;
    while (pos < src.length) {
      if (guard-- <= 0) throw new UnsupportedError('inline loop');
      if (!keepPrevChar) prevChar = '';
      keepPrevChar = false;
      const sub = src.slice(pos);
      // First-char dispatch: plain text is the common case, and trying
      // every inline regex before textRe wastes ~10 failed execs per
      // text token. Each branch tries exactly the token types that can
      // start with this character, in marked's original order, then
      // falls through to the text token. A URL/email can only start
      // with a letter, digit, '.', '_', '+', or '-'.
      const ch = src[pos];
      let m;
      if (ch === '\\') {
        m = escapeRe.exec(sub);
        if (m) {
          out.push(plain ? m[1] : escapeHtml(m[1]));
          pos += m[0].length;
          continue;
        }
        m = brRe.exec(sub);
        if (m) {
          out.push(plain ? '' : '<br>');
          pos += m[0].length;
          continue;
        }
      } else if (ch === '<') {
        m = tagRe.exec(sub);
        if (m) {
          if (!this.inLink && other.startATag.test(m[0])) this.inLink = true;
          else if (this.inLink && other.endATag.test(m[0])) this.inLink = false;
          if (!this.inRawBlock && other.startPreScriptTag.test(m[0])) this.inRawBlock = true;
          else if (this.inRawBlock && other.endPreScriptTag.test(m[0])) this.inRawBlock = false;
          out.push(m[0]);
          pos += m[0].length;
          continue;
        }
        m = autolinkRe.exec(sub);
        if (m) {
          let text, href;
          if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
          else { text = m[1]; href = text; }
          if (plain) {
            out.push(text);
          } else {
            const cleanHref = cleanUrl(href);
            if (cleanHref === null) out.push(escapeHtml(text, true));
            else out.push('<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>');
          }
          pos += m[0].length;
          continue;
        }
      } else if (ch === '[' || ch === '!') {
        const link = this.tryLink(sub);
        if (link) {
          out.push(link.html);
          pos += link.len;
          continue;
        }
        const ref = this.tryReflink(sub);
        if (ref) {
          out.push(ref.html);
          pos += ref.len;
          continue;
        }
      } else if (ch === '*' || ch === '_') {
        const em = this.tryEmStrong(sub, pos, prevChar, plain);
        if (em) {
          out.push(em.html);
          pos += em.len;
          continue;
        }
        if (ch === '_' && !this.inLink) {
          const url = this.tryUrl(sub, plain);
          if (url) {
            out.push(url.html);
            pos += url.len;
            continue;
          }
        }
      } else if (ch === '`') {
        m = inlineCodeRe.exec(sub);
        if (m) {
          let text = m[2].replace(other.newLineCharGlobal, ' ');
          const hasNonSpaceChars = other.nonSpaceChar.test(text);
          const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
          if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
          out.push(plain ? text : '<code>' + escapeHtml(text, true) + '</code>');
          pos += m[0].length;
          continue;
        }
      } else if (ch === '~') {
        const del = this.tryDel(sub, pos, prevChar, plain);
        if (del) {
          out.push(del.html);
          pos += del.len;
          continue;
        }
      } else if (ch === ' ') {
        m = brRe.exec(sub);
        if (m) {
          out.push(plain ? '' : '<br>');
          pos += m[0].length;
          continue;
        }
      } else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
        || (ch >= '0' && ch <= '9') || ch === '.' || ch === '+' || ch === '-') {
        if (!this.inLink) {
          const url = this.tryUrl(sub, plain);
          if (url) {
            out.push(url.html);
            pos += url.len;
            continue;
          }
        }
      }

      m = textRe.exec(sub);
      if (m) {
        const raw = m[0];
        if (plain) {
          out.push(this.inRawBlock ? raw : decodeNumericCharacterReferences(raw));
        } else {
          out.push(this.inRawBlock ? raw : escapeHtml(decodeNumericCharacterReferences(raw)));
        }
        if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        keepPrevChar = true;
        pos += raw.length;
        continue;
      }

      throw new UnsupportedError('no inline token');
    }
    return out.join('');
  }

  /** Produce the HTML for a link/image token, or null when it must not form. */
  outputLink(cap, href, title, raw) {
    const text = cap[1].replace(other.outputLinkReplace, '$1');
    const isImage = cap[0].charAt(0) === '!';
    const outerInLink = this.inLink;
    const outerLinkEmitted = this.linkEmitted;
    const outerInRawBlock = this.inRawBlock;
    this.inLink = true;
    this.linkEmitted = false;
    const inner = this.inline(text, isImage ? true : this.run.plain);
    const textHasLink = this.linkEmitted;
    this.linkEmitted = outerLinkEmitted;
    this.inLink = outerInLink;
    if (this.run.plain) {
      // TextRenderer form (image alt text): links and images render as
      // their plain inner text, with no <a>/<img> wrapping. The
      // links-may-not-nest formation rule still applies.
      if (!isImage) {
        if (textHasLink) {
          this.inRawBlock = outerInRawBlock;
          return null;
        }
        this.linkEmitted = true;
      }
      return { html: inner, len: raw.length };
    }
    if (!isImage) {
      // CommonMark: links may not contain other links, at any level.
      if (textHasLink) {
        this.inRawBlock = outerInRawBlock;
        return null;
      }
      this.linkEmitted = true;
      // In plain mode (image alt text) marked renders links with its
      // TextRenderer, i.e. as plain text, not as <a> tags. cm-575.
      if (this.run.plain) return { html: inner, len: raw.length };
      const cleanHref = cleanUrl(href);
      if (cleanHref === null) return { html: inner, len: raw.length };
      let out = '<a href="' + escapeHtml(cleanHref) + '"';
      if (title) out += ' title="' + escapeHtml(title) + '"';
      out += '>' + inner + '</a>';
      return { html: out, len: raw.length };
    }
    // In plain mode (image alt text) a nested image also renders as the
    // plain text of its own alt, not as an <img> tag. cm-520, cm-574.
    if (this.run.plain) return { html: inner, len: raw.length };
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: escapeHtml(inner), len: raw.length };
    let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(inner) + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    out += '>';
    return { html: out, len: raw.length };
  }

  tryLink(sub) {
    if (!this.run.hasParen) return null;
    const cap = linkRe.exec(sub);
    if (!cap) return null;
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(sub, cap[1], labelStart)) return null;
    const trimmedUrl = cap[2].trim();
    if (other.startAngleBracket.test(trimmedUrl)) {
      if (!other.endAngleBracket.test(trimmedUrl)) return null;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return null;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return null;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
    return this.outputLink(
      cap,
      href ? href.replace(anyPunctuationRe, '$1') : href,
      title ? title.replace(anyPunctuationRe, '$1') : title,
      cap[0],
    );
  }

  tryReflink(sub) {
    const cap = reflinkRe.exec(sub) || nolinkRe.exec(sub);
    if (!cap) return null;
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(sub, cap[1], labelStart)) return null;
    const link = this.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const ch = cap[0].charAt(0);
      return { html: ch, len: 1 };
    }
    return this.outputLink(cap, link.href, link.title, cap[0]);
  }

  tryEmStrong(sub, pos, prevChar, plain) {
    let match = emStrongLDelimRe.exec(sub);
    if (!match) return null;
    if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
    const delimChar = match[0][0];
    const midRun = prevChar === delimChar;
    const masked = this.run.masked;
    const srcStart = pos;
    let runStart = srcStart;
    while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
    const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!punctuationRe.exec(runPrevChar);
    if (runStart < srcStart) prevChar = runPrevChar;
    const prevPunct = runStart < srcStart ? runPrevPunct : !!punctuationRe.exec(prevChar);
    if (match[4] && prevChar.match(other.unicodeAlphaNumeric)) return null;
    const nextChar = match[1] || match[3] || '';
    if (!nextChar || !prevChar || prevPunct) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !!runPrevChar.trim()
        && (!!nextChar || (delimChar === '*' && !runPrevPunct));
      if (delimChar !== '*' && delimChar !== '_') return null;
      const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
      const lastPossible = delimChar === '*' ? this.run.hints.ast : this.run.hints.und;
      const windowStart = pos + lLength;
      if (lastPossible < windowStart) return null;
      const clipped = masked.slice(pos + lLength);
      const lastPossibleInWindow = lastPossible - windowStart;
      endReg.lastIndex = 0;
      while ((match = endReg.exec(clipped)) !== null) {
        if (match.index > lastPossibleInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = [...rDelim].length;
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
        rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const lastCharLength = [...match[0]][0].length;
        const rawLen = lLength + match.index + lastCharLength + rLength;
        if (Math.min(lLength, rLength) % 2) {
          const text = sub.slice(1, 1 + rawLen - 2);
          const inner = this.inline(text, plain);
          return { html: plain ? inner : '<em>' + inner + '</em>', len: rawLen };
        }
        const text = sub.slice(2, 2 + rawLen - 4);
        const inner = this.inline(text, plain);
        return { html: plain ? inner : '<strong>' + inner + '</strong>', len: rawLen };
      }
    }
    return null;
  }

  tryDel(sub, pos, prevChar, plain) {
    let match = delLDelimRe.exec(sub);
    if (!match) return null;
    const nextChar = match[1] || '';
    if (!nextChar || !prevChar || punctuationRe.exec(prevChar)) {
      const lLength = [...match[0]].length - 1;
      let rDelim, rLength, delimTotal = lLength;
      const masked = this.run.masked;
      const lastPossible = this.run.hints.del;
      const windowStart = pos + lLength;
      if (lastPossible < windowStart) return null;
      const clipped = masked.slice(pos + lLength);
      const lastPossibleInWindow = lastPossible - windowStart;
      delRDelimRe.lastIndex = 0;
      while ((match = delRDelimRe.exec(clipped)) !== null) {
        if (match.index > lastPossibleInWindow) break;
        rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!rDelim) continue;
        rLength = [...rDelim].length;
        if (rLength !== lLength) continue;
        if (match[3] || match[4]) {
          delimTotal += rLength;
          continue;
        }
        delimTotal -= rLength;
        if (delimTotal > 0) continue;
        rLength = Math.min(rLength, rLength + delimTotal);
        const lastCharLength = [...match[0]][0].length;
        const rawLen = lLength + match.index + lastCharLength + rLength;
        const text = sub.slice(lLength, lLength + rawLen - 2 * lLength);
        const inner = this.inline(text, plain);
        return { html: plain ? inner : '<del>' + inner + '</del>', len: rawLen };
      }
    }
    return null;
  }

  tryUrl(sub, plain) {
    const cap = urlRe.exec(sub);
    if (!cap) return null;
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = backpedalRe.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
    }
    if (plain) return { html: text, len: cap[0].length };
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: escapeHtml(text, true), len: cap[0].length };
    return { html: '<a href="' + escapeHtml(cleanHref, true) + '">' + escapeHtml(text, true) + '</a>', len: cap[0].length };
  }
}

class UnsupportedError extends Error {}

/* ------------------------------------------------------------------ */
/* Block layer: marked's block lexer, producing a light node tree.     */
/* Nodes are arrays: ['space', raw], ['code', lang, text],             */
/* ['heading', depth, text], ['hr'], ['html', text], ['def'],          */
/* ['table', headerTexts, aligns, rowTexts],                           */
/* ['paragraph', raw, text], ['text', raw, text],                      */
/* ['blockquote', raw, text, children],                                */
/* ['list', ordered, start, loose, items],                             */
/* ['item', task, checked, loose, raw, text, children].                */
/* Inline rendering is deferred until the whole tree is built, so      */
/* link reference definitions are known before any link is rendered.   */
/* ------------------------------------------------------------------ */

/** Does `line` (without its newline) start a block that interrupts a paragraph? */
function lineInterruptsParagraph(line) {
  // hr
  if (isHrLine(line)) return true;
  // ATX heading
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  // blockquote
  if (/^ {0,3}>/.test(line)) return true;
  // fences: a backtick fence only interrupts when its info string holds
  // no backtick (marked's fence lookahead `(?=[^`\n]*(?:\n|$))`); a line
  // like ```inner backticks``` is paragraph continuation. doc-05/21.
  if (/^ {0,3}`{3,}(?=[^`]*$)/.test(line) || /^ {0,3}~{3,}/.test(line)) return true;
  // list: only non-empty lists starting from 1 (or any bullet) interrupt
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  // html block types 1-6
  if (isHtmlBeginLine(line)) return true;
  return false;
}

function isHrLine(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (i === 3 && line[3] === ' ') return false;
  const ch = line[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

function isHtmlBeginLine(line) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  if (line[i] !== '<') return false;
  const rest = line.slice(i);
  if (/^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|$|\/?>)/i.test(rest)) return true;
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--') || rest.startsWith('<?') || /^<![A-Za-z]/.test(rest) || rest.startsWith('<![CDATA[')) return true;
  return false;
}

/** Split `src` at the first newline; returns [lineWithoutNewline, restStart]. */
function firstLine(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return [src, src.length];
  return [src.slice(0, nl), nl + 1];
}

class BlockParser {
  constructor() {
    this.links = Object.create(null);
    this.engine = new InlineEngine(this.links);
    this.top = true;
  }

  blockTokens(src, nodes = [], lastParagraphClipped = false) {
    let guard = src.length + 2;
    while (src) {
      if (guard-- <= 0) throw new UnsupportedError('block loop');
      let node = null;
      let len = 0;

      // newline / space
      let m = newlineRe.exec(src);
      if (m && m[0].length > 0) {
        len = m[0].length;
        const last = nodes.at(-1);
        if (len === 1 && last !== undefined) {
          // A single \n spacer terminates the last line, so it is moved
          // onto the last token's raw instead of becoming a space token.
          if (last[0] === 'paragraph' || last[0] === 'text') last[1] += '\n';
        } else {
          nodes.push(['space', m[0]]);
        }
        src = src.substring(len);
        continue;
      }

      // indented code
      m = blockCodeRe.exec(src);
      if (m) {
        const raw = trimTrailingBlankLines(m[0]);
        const text = raw.replace(other.codeRemoveIndent, '');
        const last = nodes.at(-1);
        if (last?.[0] === 'paragraph' || last?.[0] === 'text') {
          // An indented code block cannot interrupt a paragraph.
          last[1] += (last[1].endsWith('\n') ? '' : '\n') + raw;
          last[2] += '\n' + text;
        } else {
          nodes.push(['code', '', text]);
        }
        // Consume only the trimmed raw: marked's code token raw is
        // ge(match) (trailing blank lines trimmed), and blockTokens
        // consumes raw.length, so a blank line after the code stays in
        // src and becomes a space token (looseness!). Consuming the
        // full match swallowed it and lists came out tight. (fuzz3.)
        src = src.substring(raw.length);
        continue;
      }

      // fences
      node = this.tokFences(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // ATX heading
      node = this.tokHeading(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // hr
      node = this.tokHr(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // blockquote
      node = this.tokBlockquote(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // list
      node = this.tokList(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // html
      m = htmlRe.exec(src);
      if (m) {
        const raw = trimTrailingBlankLines(m[0]);
        nodes.push(['html', raw]);
        // As for indented code: marked's html raw is ge(match), and
        // blockTokens consumes raw.length, leaving trailing blank
        // lines in src to form space tokens.
        src = src.substring(raw.length);
        continue;
      }

      // def
      m = defRe.exec(src);
      if (m) {
        if (!other.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
          // not a definition; fall through to the next tokenizer
        } else {
          const tag = normalizeLabel(m[1]);
          const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
          const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(anyPunctuationRe, '$1') : m[3];
          const raw = rtrim(m[0], '\n');
          const last = nodes.at(-1);
          if (last?.[0] === 'paragraph' || last?.[0] === 'text') {
            last[1] += (last[1].endsWith('\n') ? '' : '\n') + raw;
            last[2] += '\n' + raw;
          } else {
            if (!this.links[tag]) this.links[tag] = { href, title };
            nodes.push(['def']);
          }
          // marked's def raw is L(match, '\n'); consume raw.length so
          // trailing newlines stay in src (see the code/html branches).
          src = src.substring(raw.length);
          continue;
        }
      }

      // table (gfm)
      node = this.tokTable(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // setext heading (lheading) — tried before paragraph
      node = this.tokLheading(src);
      if (node) {
        nodes.push(node[0]);
        src = src.substring(node[1]);
        continue;
      }

      // paragraph (top level only)
      if (this.top) {
        node = this.tokParagraph(src);
        if (node) {
          const last = nodes.at(-1);
          if (lastParagraphClipped && last?.[0] === 'paragraph') {
            last[1] += (last[1].endsWith('\n') ? '' : '\n') + node[0][1];
            last[2] += '\n' + node[0][2];
          } else {
            nodes.push(node[0]);
          }
          lastParagraphClipped = false;
          src = src.substring(node[1]);
          continue;
        }
      }

      // text (fallback: one line, merged into a previous text token).
      // NOTE: do NOT consume the line's trailing newline here. marked's
      // text token is /^[^\\n]+/ (no trailing \n), so a following blank
      // line reaches the newline branch as a full "\n\n" and becomes a
      // space token; consuming the \n here used to split it and lists
      // that should be loose rendered tight.
      {
        const nl = src.indexOf('\n');
        const line = nl === -1 ? src : src.slice(0, nl);
        const last = nodes.at(-1);
        if (last?.[0] === 'text') {
          last[1] += (last[1].endsWith('\n') ? '' : '\n') + line;
          last[2] += '\n' + line;
        } else {
          nodes.push(['text', line, line]);
        }
        src = src.substring(nl === -1 ? src.length : nl);
        continue;
      }
    }
    this.top = true;
    return nodes;
  }

  tokFences(src) {
    let i = 0;
    while (i < 3 && src[i] === ' ') i++;
    if (i === 3 && src[i] === ' ') return null;
    const ch = src[i];
    if (ch !== '`' && ch !== '~') return null;
    let j = i;
    while (src[j] === ch) j++;
    const len = j - i;
    if (len < 3) return null;
    const nl = src.indexOf('\n', j);
    const lineEnd = nl === -1 ? src.length : nl;
    const info = src.slice(j, lineEnd);
    if (ch === '`' && info.includes('`')) return null;
    const contentStart = lineEnd === src.length ? src.length : lineEnd + 1;
    let pos = contentStart;
    let closeStart = -1;
    let closeEnd = src.length;
    while (pos < src.length) {
      const n2 = src.indexOf('\n', pos);
      const le = n2 === -1 ? src.length : n2;
      const line = src.slice(pos, le);
      let s = 0;
      while (s < 3 && line[s] === ' ') s++;
      if (line[s] === ch) {
        let t = s;
        while (line[t] === ch) t++;
        if (t - s >= len) {
          let u = t;
          while (u < line.length && line[u] === ' ') u++;
          if (u === line.length) {
            closeStart = pos;
            closeEnd = le;
            break;
          }
        }
      }
      pos = le === src.length ? src.length : le + 1;
    }
    let text;
    if (closeStart === -1) {
      text = src.slice(contentStart);
      if (text.endsWith('\n')) text = text.slice(0, -1);
    } else if (closeStart === contentStart) {
      text = '';
    } else {
      text = src.slice(contentStart, closeStart - 1);
    }
    if (ch === '`' && i > 0) {
      // indentCodeCompensation: remove up to the fence's own indent per line
      const lines = text.split('\n');
      for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        let n = 0;
        while (n < i && (line[n] === ' ' || line[n] === '\t')) n++;
        if (n > 0) lines[k] = line.slice(n);
      }
      text = lines.join('\n');
    }
    const lang = info ? info.trim().replace(anyPunctuationRe, '$1') : info;
    // Consume up to the end of the closing fence line only: marked's
    // fences raw is the regex match, whose closing part ends with a
    // lookahead (?=\n|$), not a consumed newline. (A trailing \n that
    // shows up on marked's fence raw comes from its space branch
    // merging a lone newline into the previous token, not from the
    // fence match; consuming it here would eat a blank line after a
    // fence inside a list item and break looseness — cm-324.)
    const rawLen = closeStart === -1 ? src.length : closeEnd;
    return [['code', lang, text], rawLen];
  }

  tokHeading(src) {
    let i = 0;
    while (i < 3 && src[i] === ' ') i++;
    if (i === 3 && src[i] === ' ') return null;
    let j = i;
    while (src[j] === '#') j++;
    const depth = j - i;
    if (depth === 0 || depth > 6) return null;
    const c = src[j];
    if (c !== undefined && c !== ' ' && c !== '\t' && c !== '\n') return null;
    const nl = src.indexOf('\n', j);
    const lineEnd = nl === -1 ? src.length : nl;
    let text = src.slice(j, lineEnd).trim();
    if (other.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    // Consume only up to the end of the heading line: marked's heading
    // raw is L(match, '\n'), so trailing newlines stay in src.
    const rawLen = lineEnd;
    return [['heading', depth, text], rawLen];
  }

  tokHr(src) {
    const [line, next] = firstLine(src);
    if (!isHrLine(line)) return null;
    // Consume only the hr line itself: marked's hr raw is L(match,
    // '\n'), so trailing newlines stay in src and form space tokens
    // (they matter for list looseness). The old version swallowed them.
    return [['hr'], line.length];
  }

  /** Setext heading, tried before paragraph. Returns [node, consumed] or null.
   * Scans lines lazily: the old version split the whole remaining src
   * into a line array on every call (one allocation per line, per block
   * start), which dominated docs time. Behaviour identical. */
  tokLheading(src) {
    // First line: the heading text must not itself start a block.
    let nl = src.indexOf('\n');
    const firstEnd = nl === -1 ? src.length : nl;
    const first = src.slice(0, firstEnd);
    if (first === '' || /^(?: {4}| {0,3}\t)/.test(first)) return null;
    if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(first)) return null;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(first)) return null;
    if (/^ {0,3}>/.test(first)) return null;
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(first)) return null;
    if (/^ {0,3}<[^>\n]+>$/.test(first)) return null;
    if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(first)) return null;
    let pos = firstEnd === src.length ? src.length : firstEnd + 1;
    while (pos <= src.length) {
      const lineStart = pos;
      nl = src.indexOf('\n', pos);
      const lineEnd = nl === -1 ? src.length : nl;
      const line = src.slice(pos, lineEnd);
      const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (m) {
        const text = src.slice(0, lineStart - 1).trim();
        let rawLen = lineEnd;
        while (src[rawLen] === '\n') rawLen++;
        return [['heading', m[1].charAt(0) === '=' ? 1 : 2, text], rawLen];
      }
      if (line === '' || /^[ \t]+$/.test(line)) return null;
      // A continuation line only breaks the heading when it starts a
      // list item the way marked's lheading lookahead sees it: bullet
      // followed by a literal space (a bare `*` or `*\t...` line stays
      // part of the heading text). The first-line guard above keeps
      // the (?:[ \t]|$) form because the list rule itself wins there.
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return null;
      if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return null;
      if (/^ {0,3}>/.test(line)) return null;
      if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return null;
      if (isHrLine(line)) return null;
      if (/^ {0,3}<[^>\n]+>$/.test(line)) return null;
      if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line)) return null;
      if (nl === -1) break;
      pos = lineEnd + 1;
    }
    return null;
  }

  /** Is there a GFM table starting at `pos` in `src`? (paragraph interrupt) */
  isTableStart(src, pos) {
    const sub = src.slice(pos);
    const nl = sub.indexOf('\n');
    if (nl === -1) return false;
    const nl2 = sub.indexOf('\n', nl + 1);
    const nextLine = nl2 === -1 ? sub.slice(nl + 1) : sub.slice(nl + 1, nl2);
    // A table delimiter is `-+` with optional `:`/`|`; a bare `---`
    // counts (marked's paragraph regex stops a paragraph before a line
    // followed by one, so `baz` in `Foo\n<a..>\nbaz\n---` ends the
    // paragraph and `baz` becomes a setext heading). Only `-` is
    // required for the fast path; gfmTableRe decides the rest.
    if (!nextLine.includes('-')) return false;
    return gfmTableRe.test(sub);
  }

  tokParagraph(src) {
    let pos = 0;
    let end = 0;
    let first = true;
    while (pos < src.length) {
      const nl = src.indexOf('\n', pos);
      const lineEnd = nl === -1 ? src.length : nl;
      const line = src.slice(pos, lineEnd);
      if (!first) {
        if (line === '') break;
        // A whitespace-only line ends the paragraph, except when it is
        // the last line of the input (no newline after it): marked's
        // paragraph regex keeps that trailing whitespace in the text
        // (its lookahead only stops at `[ \t]+\n`). cm-241.
        if (/^[ \t]+$/.test(line) && nl !== -1) break;
        if (lineInterruptsParagraph(line)) break;
        if (this.isTableStart(src, pos)) break;
      }
      end = lineEnd;
      if (nl === -1) { pos = src.length; break; }
      pos = nl + 1;
      first = false;
    }
    const text = src.slice(0, end);
    return [['paragraph', text, text], end];
  }

  tokTable(src) {
    const cap = gfmTableRe.exec(src);
    if (!cap) return null;
    if (!other.tableDelimiter.test(cap[2])) return null;
    const headers = splitCells(cap[1]);
    const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
    if (headers.length !== aligns.length) return null;
    const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
    const alignVals = [];
    for (const align of aligns) {
      if (other.tableAlignRight.test(align)) alignVals.push('right');
      else if (other.tableAlignCenter.test(align)) alignVals.push('center');
      else if (other.tableAlignLeft.test(align)) alignVals.push('left');
      else alignVals.push(null);
    }
    const rowTexts = rows.map((row) => splitCells(row, headers.length));
    // marked's table raw is L(match, '\n'); consume the trimmed length
    // so trailing newlines stay in src (space tokens / looseness).
    return [['table', headers, alignVals, rowTexts], rtrim(cap[0], '\n').length];
  }

  tokBlockquote(src) {
    const cap = blockquoteRe.exec(src);
    if (!cap) return null;
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const children = [];
    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (other.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);
      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(
          other.blockquoteMarkerWhitespace,
          (_m, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
        )
        .replace(other.blockquoteSetextReplace, '\n    $1')
        .replace(other.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;
      const savedTop = this.top;
      this.top = true;
      this.blockTokens(currentText, children, true);
      this.top = savedTop;
      if (lines.length === 0) break;
      const last = children.at(-1);
      if (last?.[0] === 'code' || last?.[0] === 'heading' || last?.[0] === 'hr' || last?.[0] === 'html' || last?.[0] === 'table') {
        break;
      } else if (last?.[0] === 'blockquote') {
        const oldNode = last;
        const continuation = lines.join('\n');
        const newText = oldNode[1] + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
        const res = this.tokBlockquote(newText);
        const newNode = res[0];
        children[children.length - 1] = newNode;
        const leftover = newText.substring(newNode[1].length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldNode[2].length) + newNode[2];
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.[0] === 'list') {
        const oldNode = last;
        const newText = oldNode[5] + '\n' + lines.join('\n');
        const res = this.tokList(newText);
        const newNode = res[0];
        children[children.length - 1] = newNode;
        const consumedCount = newNode[5].length > oldNode[5].length
          ? newText.slice(oldNode[5].length + 1, newNode[5].length).split('\n').length
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
    return [['blockquote', raw, text, children], raw.length];
  }

  tokList(src) {
    const cap0 = listRe.exec(src);
    if (!cap0) return null;
    const listSrc = src;
    let bull = cap0[1].trim();
    const isordered = bull.length > 1;
    const listNode = ['list', isordered, isordered ? +bull.slice(0, -1) : '', false, [], ''];
    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
    const itemRegex = other.listItemRegex(bull);
    let endsWithBlankLine = false;
    const taken = () => listSrc.length - src.length;
    src = listSrc;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      let cap = itemRegex.exec(src);
      if (!cap) break;
      if (hrRe.test(src)) break;
      const itemStart = taken();
      src = src.substring(cap[0].length);
      const firstLine = cap[2].split('\n', 1)[0];
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
      let nextLine = src.split('\n', 1)[0];
      let blankLine = !line.trim();
      let indent = 0;
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
        const nextBulletRegex = cachedRegex('nextBullet', indent, other.nextBulletRegex);
        const hrRegex = cachedRegex('hr', indent, other.hrRegex);
        const fencesBeginRegex = cachedRegex('fences', indent, other.fencesBeginRegex);
        const headingBeginRegex = cachedRegex('heading', indent, other.headingBeginRegex);
        const htmlBeginRegex = cachedRegex('html', indent, other.htmlBeginRegex);
        const blockquoteBeginRegex = cachedRegex('blockquote', indent, other.blockquoteBeginRegex);
        while (src) {
          // indexOf + slice instead of split('\n', 1): no array alloc per line.
          const nlIdx = src.indexOf('\n');
          const rawLine = nlIdx === -1 ? src : src.slice(0, nlIdx);
          nextLine = rawLine;
          // Only expand leading tabs when the line actually has one;
          // plain leading spaces pass through expandTabs unchanged.
          const nextLineWithoutTabs = nextLine.indexOf('\t') === -1
            ? nextLine
            : nextLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws));
          if (fencesBeginRegex.test(nextLine)) break;
          if (headingBeginRegex.test(nextLine)) break;
          if (htmlBeginRegex.test(nextLine)) break;
          if (blockquoteBeginRegex.test(nextLine)) break;
          if (nextBulletRegex.test(nextLine)) break;
          if (hrRegex.test(nextLine)) break;
          if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            if (line.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4) break;
            if (fencesBeginRegex.test(line)) break;
            if (headingBeginRegex.test(line)) break;
            if (htmlBeginRegex.test(line)) break;
            if (hrRegex.test(line)) break;
            const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && lheadingGfmRe.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }
          blankLine = !nextLine.trim();
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }
      const raw = listSrc.slice(itemStart, taken());
      if (!listNode[3]) {
        if (endsWithBlankLine) listNode[3] = true;
        else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
      }
      listNode[4].push(['item', false, false, false, raw, itemContents, []]);
    }
    const lastItem = listNode[4].at(-1);
    if (lastItem) {
      lastItem[4] = lastItem[4].trimEnd();
      lastItem[5] = lastItem[5].trimEnd();
    } else {
      return null;
    }
    listNode[5] = listSrc.slice(0, taken()).trimEnd();
    // First pass: lex each item's children, decide looseness.
    // NOTE: do NOT save/restore `top` around the item lexing. marked
    // sets state.top=false before each item's blockTokens and leaves
    // whatever blockTokens returns in place; a nested list's blockTokens
    // returns with top=true, so a paragraph later in the same item is
    // lexed by the paragraph rule (keeping e.g. a setext-continuation
    // indent). Saving/restoring top here made such paragraphs lex as
    // text tokens, which strip the indent. (fuzz2: baz\n    === case.)
    for (const item of listNode[4]) {
      item[1] = other.listIsTask.test(item[5]);
      this.top = false;
      item[6] = this.blockTokens(item[5], []);
      if (!listNode[3]) {
        const spacers = item[6].filter((t) => t[0] === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t[1]));
        listNode[3] = hasMultipleLineBreaks;
      }
    }
    // Second pass: task checkboxes.
    for (const item of listNode[4]) {
      const firstChild = item[6][0];
      if (item[1] && (firstChild?.[0] === 'text' || firstChild?.[0] === 'paragraph')) {
        item[5] = item[5].replace(other.listReplaceTask, '');
        firstChild[1] = firstChild[1].replace(other.listReplaceTask, '');
        firstChild[2] = firstChild[2].replace(other.listReplaceTask, '');
        const taskRaw = other.listTaskCheckbox.exec(item[4]);
        if (taskRaw) item[2] = taskRaw[0] !== '[ ]';
      } else if (item[1]) {
        item[1] = false;
      }
    }
    if (listNode[3]) {
      for (const item of listNode[4]) {
        item[3] = true;
        for (const token of item[6]) {
          if (token[0] === 'text') token[0] = 'paragraph';
        }
      }
    }
    return [listNode, listNode[5].length];
  }

  /** Render one block node's inline content (resets the raw-block state). */
  inlineText(text) {
    this.engine.inRawBlock = false;
    return this.engine.inline(text, false);
  }

  renderNode(node) {
    switch (node[0]) {
      case 'space':
      case 'def':
        return '';
      case 'hr':
        return '<hr>\n';
      case 'heading':
        return '<h' + node[1] + '>' + this.inlineText(node[2]) + '</h' + node[1] + '>\n';
      case 'code': {
        const langString = (node[1] || '').match(other.notSpaceStart)?.[0];
        const code = node[2] ? node[2].replace(other.endingNewline, '') + '\n' : '';
        if (!langString) return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        return '<pre><code class="language-' + escapeHtml(langString) + '">'
          + escapeHtml(code, true) + '</code></pre>\n';
      }
      case 'html':
        return node[1];
      case 'paragraph':
        return '<p>' + this.inlineText(node[2]) + '</p>\n';
      case 'text':
        return this.inlineText(node[2]);
      case 'table': {
        const headers = node[1];
        const aligns = node[2];
        const rows = node[3];
        let cell = '';
        for (let j = 0; j < headers.length; j++) cell += this.tableCell(headers[j], true, aligns[j]);
        const header = '<tr>\n' + cell + '</tr>\n';
        let body = '';
        for (const row of rows) {
          cell = '';
          for (let k = 0; k < row.length; k++) cell += this.tableCell(row[k], false, aligns[k]);
          body += '<tr>\n' + cell + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
      }
      case 'blockquote':
        return '<blockquote>\n' + this.renderBlocks(node[3]) + '</blockquote>\n';
      case 'list': {
        const ordered = node[1];
        const start = node[2];
        let body = '';
        for (const item of node[4]) body += this.listItem(item);
        const type = ordered ? 'ol' : 'ul';
        const startAttr = (ordered && start !== 1) ? (' start="' + start + '"') : '';
        return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
      }
      default:
        throw new UnsupportedError('unknown block ' + node[0]);
    }
  }

  tableCell(text, isHeader, align) {
    const content = this.inlineText(text);
    const type = isHeader ? 'th' : 'td';
    const tag = align ? '<' + type + ' align="' + align + '">' : '<' + type + '>';
    return tag + content + '</' + type + '>\n';
  }

  listItem(item) {
    const children = item[6];
    const first = children[0];
    const checkbox = item[1] && (first?.[0] === 'text' || first?.[0] === 'paragraph')
      ? '<input ' + (item[2] ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '
      : null;
    let body = '';
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (i === 0 && checkbox && (child[0] === 'text' || child[0] === 'paragraph')) {
        if (child[0] === 'paragraph') body += '<p>' + checkbox + this.inlineText(child[2]) + '</p>\n';
        else body += checkbox + this.inlineText(child[2]);
      } else {
        body += this.renderNode(child);
      }
    }
    return '<li>' + body + '</li>\n';
  }

  renderBlocks(nodes) {
    let out = '';
    for (const node of nodes) out += this.renderNode(node);
    return out;
  }
}

/* Per-indent regex cache, mirroring marked's cachedIndentRegex. */
const regexCache = new Map();
function cachedRegex(kind, indent, make) {
  const key = kind + ':' + Math.max(0, Math.min(3, indent - 1));
  let re = regexCache.get(key);
  if (!re) {
    re = make(Math.max(0, Math.min(3, indent - 1)));
    regexCache.set(key, re);
  }
  return re;
}

/* GFM setext-heading regex, for the list tokenizer's lazy-setext check. */
const lheadingGfmRe = edit(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, bulletRe)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * The HTML marked 18.1.3 renders for `markdown` with its defaults.
 * Constructs this file does not cover fall back to marked itself.
 */
export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(other.carriageReturn, '\n') : markdown;
  try {
    const parser = new BlockParser();
    const nodes = parser.blockTokens(src);
    return parser.renderBlocks(nodes);
  } catch (e) {
    if (e instanceof UnsupportedError) return marked.parse(markdown);
    throw e;
  }
}
