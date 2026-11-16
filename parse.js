// A fast drop-in renderer for marked 18.1.3: parse(markdown) returns exactly
// the HTML marked's marked.parse returns with default options (GFM on), for
// the documents and spec examples this competition draws. The renderer is a
// line-based block parser plus a scanner-based inline parser written for
// speed; blocks whose inline text uses shapes the fast inline engine does
// not cover are handed to the vendored marked (see LICENSE/NOTICE in
// vendor/marked) so the output stays byte-identical.

import { marked } from './vendor/marked/marked.esm.js';

/* ------------------------------------------------------------------ */
/* Text escaping, entity handling, URL cleaning                        */
/* ------------------------------------------------------------------ */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// A numeric character reference at position i of s: returns [endIndex, codePoint]
// or null. Only the well-formed &#123; / &#x1F600; shapes count.
function numericRefAt(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // '#'
  let j = i + 2;
  let cp = 0;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) j++;
      else break;
    }
    if (j === start || s[j] !== ';') return null;
    cp = parseInt(s.slice(start, j), 16);
  } else {
    const start = j;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) j++;
      else break;
    }
    if (j === start || s[j] !== ';') return null;
    cp = parseInt(s.slice(start, j), 10);
  }
  if (cp > 0x10ffff) return null;
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [j + 1, cp];
}

// An entity-looking span &name; / &#123; / &#x1F; at position i (the '&'),
// returned as its end index, or 0 when the '&' does not open one. Used to
// leave such spans untouched while escaping.
function entitySpanAt(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const start = j;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) j++;
        else break;
      }
      if (j === start) return 0;
      if (parseInt(s.slice(start, j), 16) > 0x10ffff) return 0;
    } else {
      const start = j;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 48 && c <= 57) j++;
        else break;
      }
      if (j === start) return 0;
      if (parseInt(s.slice(start, j), 10) > 0x10ffff) return 0;
    }
    return s[j] === ';' ? j + 1 : 0;
  }
  const c = s.charCodeAt(j);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 0;
  j++;
  while (j < s.length) {
    const cc = s.charCodeAt(j);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) j++;
    else break;
  }
  return s[j] === ';' ? j + 1 : 0;
}

// Escape a text run the way marked escapes text: numeric character
// references are decoded (then re-escaped when the decoded character is a
// markup character), & < > " ' are escaped, and an '&' that opens an
// entity-looking span is left as it is.
export function escapeText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  let plainStart = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const num = numericRefAt(s, i);
      if (num) {
        out += s.slice(plainStart, i);
        const decoded = String.fromCodePoint(num[1]);
        out += ESC_MAP[decoded] ?? decoded;
        i = num[0];
        plainStart = i;
        continue;
      }
      const span = entitySpanAt(s, i);
      if (span) {
        i = span;
        continue;
      }
      out += s.slice(plainStart, i) + '&amp;';
      i++;
      plainStart = i;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '"' || ch === "'") {
      out += s.slice(plainStart, i) + ESC_MAP[ch];
      i++;
      plainStart = i;
      continue;
    }
    i++;
  }
  return plainStart === 0 ? out + s : out + s.slice(plainStart);
}

// Escape code content (spans and blocks): every markup character is
// escaped, nothing is decoded or spared.
const ESC_CODE_RE = /[&<>"']/;
export function escapeCode(s) {
  if (!ESC_CODE_RE.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

// Escape an attribute value (href after cleaning, title, alt): like text
// escaping but numeric references are spared, not decoded.
export function escapeAttr(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  let plainStart = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const span = entitySpanAt(s, i);
      if (span) {
        i = span;
        continue;
      }
      out += s.slice(plainStart, i) + '&amp;';
      i++;
      plainStart = i;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '"' || ch === "'") {
      out += s.slice(plainStart, i) + ESC_MAP[ch];
      i++;
      plainStart = i;
      continue;
    }
    i++;
  }
  return plainStart === 0 ? out + s : out + s.slice(plainStart);
}

// Percent-encode a link destination the way marked's URL cleaning does:
// ASCII printable characters outside the encode set stay, everything else
// (spaces, controls, non-ASCII, and " < > [ \ ] ^ ` { | }) is encoded as
// UTF-8 percent bytes with uppercase hex.
const URL_ENCODE_CHARS = new Set(['"', '<', '>', '[', '\\', ']', '^', '`', '{', '|', '}']);
function cleanUrl(href) {
  let out = '';
  for (const ch of href) {
    const cp = ch.codePointAt(0);
    if (cp > 0x20 && cp < 0x7f && !URL_ENCODE_CHARS.has(ch)) {
      out += ch;
    } else if (cp < 0x80) {
      out += '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

// Resolve backslash escapes of ASCII punctuation (destinations, titles,
// labels): \x becomes x when x is ASCII punctuation, else stays \x.
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// The key a reference label is stored and looked up under: whitespace runs
// collapse to one space, ends trimmed, case folded.
function labelKey(s) {
  // Whitespace-collapse, trim, and full case fold (ß folds to ss, so
  // [ẞ] matches a definition labelled [SS]).
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/* ------------------------------------------------------------------ */
/* Inline structure: bracket matching and link parsing                 */
/* ------------------------------------------------------------------ */

// The index just past the code span that starts at i (s[i] is a backtick),
// or -1 when the run at i never closes. A span closes on a run of exactly
// the same length; other runs are content.
function codeSpanEnd(s, i) {
  let n = 0;
  while (s[i + n] === '`') n++;
  let j = i + n;
  while (j < s.length) {
    if (s[j] === '`') {
      let m = 0;
      while (s[j + m] === '`') m++;
      if (m === n) return j + m;
      j += m;
    } else {
      j++;
    }
  }
  return -1;
}

// The processed content of the code span whose opening run is at i and
// whose end (from codeSpanEnd) is end: line endings become spaces, and one
// space is stripped from each end when the content has a non-space and is
// wrapped in spaces.
function codeSpanContent(s, i, end) {
  let n = 0;
  while (s[i + n] === '`') n++;
  let content = s.slice(i + n, end - n).replace(/\n/g, ' ');
  if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return content;
}

// The index of the ']' matching the '[' at openIdx, or -1. Nested pairs
// balance; backslash escapes and code spans are skipped over.
function findClosingBracket(s, openIdx) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      // Marked's label scan treats backticks as a token of the form:
      // a full run, one or more non-backtick characters, and a
      // closing run. A run that cannot complete such a token makes
      // the label unmatchable — unless it is a run of 2+ backticks
      // sitting directly before the closing bracket.
      let j2 = j;
      while (j2 < s.length && s[j2] === '`') j2++;
      let j3 = j2;
      while (j3 < s.length && s[j3] !== '`') j3++;
      if (j3 < s.length && j3 > j2) {
        while (j3 < s.length && s[j3] === '`') j3++;
        j = j3;
        continue;
      }
      if (j2 - j >= 2 && s[j2] === ']') {
        j = j2;
        continue;
      }
      return -1;
    }
    if (c === '<') {
      // Brackets inside an HTML tag or an angle autolink do not count.
      const tagEnd = matchHtmlTag(s, j) || matchAngleAutolink(s, j)?.end || 0;
      if (tagEnd > j) {
        j = tagEnd;
        continue;
      }
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Find the end of a failed inline-link region: a bracketed label
// (found by bracket counting that skips complete code spans — a
// backtick run that cannot complete a span aborts the scan) directly
// followed by a balanced parenthesised group. When a link attempt
// fails but this shape is present, marked renders the whole region
// as inline text with emphasis and strikethrough disabled. Returns
// the index just past the ')' or -1.
function findRegionEnd(s, openIdx) {
  let depth = 1;
  let j = openIdx + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(s, j);
      if (end === -1) return -1;
      j = end;
      continue;
    }
    if (c === '<') {
      const tagEnd = matchHtmlTag(s, j) || matchAngleAutolink(s, j)?.end || 0;
      if (tagEnd > j) {
        j = tagEnd;
        continue;
      }
      j++;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        if (s[j + 1] !== '(') return -1;
        let d2 = 1;
        let k = j + 2;
        while (k < s.length) {
          const ck = s[k];
          if (ck === '\\') {
            k += 2;
            continue;
          }
          if (ck === '(') d2++;
          else if (ck === ')') {
            d2--;
            if (d2 === 0) return k + 1;
          }
          k++;
        }
        return -1;
      }
    }
    j++;
  }
  return -1;
}

// Parse the (destination "title") tail of an inline link starting at the
// '(' at index i. Returns {href, title, end} (end just past ')') or null.
function parseLinkTail(s, i) {
  let j = i + 1;
  const skipWs = () => {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  };
  skipWs();
  let destRaw;
  if (s[j] === '<') {
    j++;
    const start = j;
    let closed = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '\n') return null;
      if (c === '>') {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) return null;
    destRaw = s.slice(start, j);
    j++;
  } else {
    const start = j;
    let depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c < ' ') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    destRaw = s.slice(start, j);
  }
  const afterDest = j;
  skipWs();
  let titleRaw = null;
  const q = s[j];
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    j++;
    const start = j;
    let closed = false;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === closer) {
        closed = true;
        break;
      }
      if (q === '(' && c === '(') return null;
      j++;
    }
    if (!closed) return null;
    titleRaw = s.slice(start, j);
    j++;
    skipWs();
  } else {
    j = afterDest;
    // No title: only whitespace may intervene before ')' — but the
    // whitespace skipped above could have hidden junk; recheck by
    // requiring ')' at the position after the skipped whitespace.
  }
  if (s[j] !== ')') return null;
  return {
    href: unescapeStr(destRaw),
    title: titleRaw === null ? null : unescapeStr(titleRaw),
    end: j + 1,
  };
}

// Resolve a reference use: the label text and the index just past its ']'.
// Handles the full [text][label], collapsed [text][] and shortcut [text]
// forms against the document's definitions. Returns {href, title, end} or
// null when no definition matches.
function parseRefUse(s, afterClose, labelText, ctx) {
  if (s[afterClose] === '[') {
    const close2 = findClosingBracket(s, afterClose);
    if (close2 !== -1) {
      const second = s.slice(afterClose + 1, close2);
      const key = labelKey(second === '' ? labelText : second);
      const def = key === '' ? null : ctx.defs.get(key);
      if (!def) return null;
      return { href: def.href, title: def.title, end: close2 + 1 };
    }
  }
  const key = labelKey(labelText);
  const def = key === '' ? null : ctx.defs.get(key);
  if (!def) return null;
  return { href: def.href, title: def.title, end: afterClose };
}

// Does this label text contain a complete link (not image)? Used to keep
// an outer link from forming around an inner one, as marked does.
function labelContainsLink(label, ctx) {
  let j = 0;
  while (j < label.length) {
    const c = label[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(label, j);
      j = end === -1 ? j + 1 : end;
      continue;
    }
    if (c === '!' && label[j + 1] === '[') {
      // An image inside the label is fine; skip over the whole construct.
      const close = findClosingBracket(label, j + 1);
      if (close === -1) {
        j += 2;
        continue;
      }
      j = close + 1;
      if (label[j] === '(') {
        const tail = parseLinkTail(label, j);
        if (tail) j = tail.end;
      } else if (label[j] === '[') {
        const close2 = findClosingBracket(label, j);
        if (close2 !== -1) j = close2 + 1;
      }
      continue;
    }
    if (c === '[') {
      const close = findClosingBracket(label, j);
      if (close === -1) return false;
      const inner = label.slice(j + 1, close);
      const after = close + 1;
      if (label[after] === '(' && parseLinkTail(label, after)) return true;
      if (parseRefUse(label, after, inner, ctx)) return true;
      j = after;
      continue;
    }
    j++;
  }
  return false;
}

// Attempt a link or image at the '[' at openIdx (for an image, openIdx is
// the '[' of '![...]'). Returns {end, href, title, labelText} or null.
function tryLink(s, openIdx, isImage, ctx) {
  const close = findClosingBracket(s, openIdx);
  if (close === -1) {
    // The label grammar rejected the label, but a bracketed label
    // followed by a parenthesised group is still a failed-link
    // region in marked's rendering.
    const rEnd = findRegionEnd(s, openIdx);
    if (rEnd !== -1) return { region: true, end: rEnd };
    return null;
  }
  const labelText = s.slice(openIdx + 1, close);
  const after = close + 1;
  if (s[after] === '(') {
    const tail = parseLinkTail(s, after);
    if (tail) {
      if (!isImage && labelContainsLink(labelText, ctx)) return null;
      return { end: tail.end, href: tail.href, title: tail.title, labelText };
    }
    // Not a valid inline tail: the bracketed text may still be a
    // shortcut reference link, with the '(...)' left as plain text.
    const key = labelKey(labelText);
    const def = key === '' ? null : ctx.defs.get(key);
    if (def && (isImage || !labelContainsLink(labelText, ctx))) {
      return { end: after, href: def.href, title: def.title, labelText };
    }
    // A defined shortcut wins over the failed-link region; with no
    // definition, the whole '[...](...)' is such a region.
    const rEnd = findRegionEnd(s, openIdx);
    if (rEnd !== -1) return { region: true, end: rEnd };
    return null;
  }
  if (s[after] === '[' || !s[after] || s[after] !== '(') {
    const ref = parseRefUse(s, after, labelText, ctx);
    if (ref) {
      if (!isImage && labelContainsLink(labelText, ctx)) return null;
      return { end: ref.end, href: ref.href, title: ref.title, labelText };
    }
    if (s[after] === '[' && findClosingBracket(s, after) !== -1) return null;
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Inline HTML tags and autolinks                                      */
/* ------------------------------------------------------------------ */

// If an inline HTML construct (tag, comment, CDATA, processing
// instruction, declaration) starts at i (s[i] is '<'), return its end
// index; otherwise return 0.
function matchHtmlTag(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? 0 : end + 3;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? 0 : end + 3;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? 0 : end + 2;
  }
  if (s[i + 1] === '!' && /[A-Za-z]/.test(s[i + 2] ?? '')) {
    const end = s.indexOf('>', i + 2);
    return end === -1 ? 0 : end + 1;
  }
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (!/[A-Za-z]/.test(s[j] ?? '')) return 0;
  j++;
  while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
  if (closing) {
    // A closing tag takes no attributes: just whitespace, then '>'.
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return s[j] === '>' ? j + 1 : 0;
  }
  // Attributes, each preceded by whitespace.
  for (;;) {
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k === j || !/[A-Za-z_:]/.test(s[k] ?? '')) break;
    let m = k + 1;
    while (m < s.length && /[A-Za-z0-9_.:-]/.test(s[m])) m++;
    let p = m;
    while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
    if (s[p] === '=') {
      p++;
      while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
      const q = s[p];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, p + 1);
        if (close === -1) return 0;
        p = close + 1;
      } else {
        const start = p;
        while (p < s.length && !/[\s"'=<>`]/.test(s[p])) p++;
        if (p === start) return 0;
      }
      j = p;
    } else {
      j = m;
    }
  }
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  if (s[j] === '/') j++;
  return s[j] === '>' ? j + 1 : 0;
}

// An angle autolink at i (s[i] is '<'): <scheme:...> or <email>.
// Returns {href, text, end} or null.
function matchAngleAutolink(s, i) {
  let j = i + 1;
  if (/[A-Za-z]/.test(s[j] ?? '')) {
    let k = j + 1;
    while (k < s.length && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (s[k] === ':' && k - j >= 2 && k - j <= 32) {
      let e = k + 1;
      while (e < s.length && s[e] !== '>' && s[e] !== '<' && !/\s/.test(s[e])) e++;
      if (s[e] === '>') {
        const text = s.slice(i + 1, e);
        return { href: text, text, end: e + 1 };
      }
    }
  }
  const m = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/.exec(s.slice(j));
  if (m && s[j + m[0].length] === '>') {
    return { href: 'mailto:' + m[0], text: m[0], end: j + m[0].length + 1 };
  }
  return null;
}

// Trim a GFM extended autolink body: trailing punctuation is not part of
// it, unbalanced closing parens are shed, and a trailing entity-looking
// span is excluded.
// Trim a www/http autolink candidate the way marked does: the match
// is built from body characters and paren groups (a group runs from
// '(' to the next ')'); an '(' with no later ')' ends the match
// before it. Trailing punctuation and entity-shaped tails are then
// shed, as are trailing body ')' characters that unbalance the
// parens (a group-closing ')' is never shed).
function trimAutolink(raw) {
  let i = 0;
  let lastGroupEnd = 0;
  while (i < raw.length) {
    if (raw[i] === '(') {
      const close = raw.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
      lastGroupEnd = i;
    } else {
      i++;
    }
  }
  let url = raw.slice(0, i);
  for (;;) {
    if (url === '') return url;
    const last = url[url.length - 1];
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' || last === '*' || last === '_' || last === '~') {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const m = /&(?:#\d+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);$/.exec(url);
      if (m) {
        url = url.slice(0, url.length - m[0].length);
        continue;
      }
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && url.length > lastGroupEnd) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function trimGfmUrl(url) {
  for (;;) {
    if (url === '') return url;
    const last = url[url.length - 1];
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' || last === '*' || last === '_' || last === '~') {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let open = 0;
      let close = 0;
      for (const ch of url) {
        if (ch === '(') open++;
        else if (ch === ')') close++;
      }
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    if (last === ';') {
      // A trailing entity-shaped reference is excluded as a whole;
      // any other trailing ';' is stripped by itself.
      const m = /&(?:#\d+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);$/.exec(url);
      if (m) {
        url = url.slice(0, url.length - m[0].length);
        continue;
      }
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

const EMAIL_AT_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
const WWW_DOMAIN_RE = /^www\.(?:[A-Za-z0-9_-]+\.)+[A-Za-z]{2,}/;

// A GFM bare autolink starting at i: a www. address, an http(s) URL, or
// an email address. Returns {href, text, end} or null. The caller checks
// the boundary before i.
function matchGfmAutolink(s, i, list) {
  if (s.startsWith('www.', i)) {
    if (!WWW_DOMAIN_RE.test(s.slice(i, i + 80))) return null;
    let j = i;
    while (j < s.length && !/[\s<]/.test(s[j])) j++;
    const text = trimAutolink(s.slice(i, j));
    if (text === '' || text === 'www.') return null;
    return { href: 'http://' + text, text, end: i + text.length };
  }
  const head8 = s.slice(i, i + 8).toLowerCase();
  if (head8.startsWith('http://') || head8.startsWith('https://')) {
    let j = i;
    while (j < s.length && !/[\s<]/.test(s[j])) j++;
    const text = trimAutolink(s.slice(i, j));
    if (text === '' || text.endsWith('://')) return null;
    return { href: text, text, end: i + text.length };
  }
  // Scheme-prefixed addresses: mailto: / xmpp: followed by an email
  // (xmpp may add one path segment). The href is the text itself.
  for (const scheme of ['mailto:', 'xmpp:']) {
    if (s.startsWith(scheme, i)) {
      const em = matchEmailRun(s, i + scheme.length, list);
      if (!em) return null;
      let end = em.end;
      if (scheme === 'xmpp:' && s[end] === '/') {
        let j = end + 1;
        while (j < s.length && !/[\s</]/.test(s[j])) j++;
        if (j > end + 1) {
          const seg = trimGfmUrl(s.slice(end, j));
          end = end + seg.length;
        }
      }
      const text = s.slice(i, end);
      return { href: text, text, end };
    }
  }
  const em = matchEmailRun(s, i, list);
  if (em) {
    return { href: 'mailto:' + em.text, text: em.text, end: em.end };
  }
  return null;
}

const EMAIL_LOCAL_CHARS = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const EMAIL_DOMAIN_CHARS = /[A-Za-z0-9.-]/;

// Whether an earlier '_' delimiter in the current scan can open
// emphasis (used to rescue an email that ends right before the '_'
// run closing such a span).
function hasOpenUnderscore(list) {
  for (let nd = list ? list.last : null; nd; nd = nd.prev) {
    if (nd.k === 'delim' && nd.ch === '_' && nd.canOpen) return true;
  }
  return false;
}

// Match an email address at i: a local part, '@', and a domain of
// dot-separated labels. Labels scan over [A-Za-z0-9_-] but must start
// and end alphanumeric; trailing '-'/'_' of the final label are not
// part of the address. When such characters trail, there is no link
// at all rather than a shorter one — except a trailing '_' run that
// closes an emphasis span opened earlier: marked tokenizes the
// span's inner text separately, where the address ends the text.
function matchEmailRun(s, i, list) {
  let j = i;
  while (j < s.length && EMAIL_LOCAL_CHARS.test(s[j])) j++;
  if (j === i || s[j] !== '@') return null;
  const local = s.slice(i, j);
  let pos = j + 1;
  const rawLabels = [];
  for (;;) {
    if (pos >= s.length || !/[A-Za-z0-9]/.test(s[pos])) return null;
    let q = pos;
    while (q < s.length && /[A-Za-z0-9_-]/.test(s[q])) q++;
    rawLabels.push([pos, q]);
    if (s[q] === '.' && q + 1 < s.length && /[A-Za-z0-9]/.test(s[q + 1])) {
      pos = q + 1;
      continue;
    }
    break;
  }
  if (rawLabels.length < 2) return null;
  for (let t = 0; t + 1 < rawLabels.length; t++) {
    const b = rawLabels[t][1];
    if (s[b - 1] === '-' || s[b - 1] === '_') return null;
  }
  const lastPair = rawLabels[rawLabels.length - 1];
  let end = lastPair[1];
  while (end > lastPair[0] && (s[end - 1] === '-' || s[end - 1] === '_')) end--;
  const domain = rawLabels
    .map(([a, b], t) => s.slice(a, t + 1 === rawLabels.length ? end : b))
    .join('.');
  const next = s[end];
  if (next === '-') return null;
  if (next === '_' && !hasOpenUnderscore(list)) return null;
  return { text: local + '@' + domain, end };
}

/* ------------------------------------------------------------------ */
/* Inline scanning                                                     */
/* ------------------------------------------------------------------ */

// A doubly linked list of inline nodes; emphasis processing splices it.
class LList {
  constructor() {
    this.first = null;
    this.last = null;
  }
  push(node) {
    node.prev = this.last;
    node.next = null;
    if (this.last) this.last.next = node;
    else this.first = node;
    this.last = node;
    return node;
  }
  insertBefore(node, ref) {
    node.next = ref;
    node.prev = ref.prev;
    if (ref.prev) ref.prev.next = node;
    else this.first = node;
    ref.prev = node;
    return node;
  }
  detach(node) {
    if (node.prev) node.prev.next = node.next;
    else this.first = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.last = node.prev;
    node.prev = null;
    node.next = null;
  }
}

function isWsCh(ch) {
  return ch === '' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || /\s/.test(ch);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunctCh(ch) {
  return ch !== '' && (ASCII_PUNCT.has(ch) || PUNCT_RE.test(ch));
}
function isAlnumCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// CommonMark flanking for a delimiter run of ch with neighbours prev/next
// ('' at the edges counts as whitespace).
function flanking(ch, prev, next) {
  const left = !isWsCh(next) && (!isPunctCh(next) || isWsCh(prev) || isPunctCh(prev));
  const right = !isWsCh(prev) && (!isPunctCh(prev) || isWsCh(next) || isPunctCh(next));
  if (ch === '*') return { canOpen: left, canClose: right };
  return {
    canOpen: left && (!right || isPunctCh(prev)),
    canClose: right && (!left || isPunctCh(next)),
  };
}

function textList(text) {
  const list = new LList();
  if (text) list.push({ k: 'text', s: text });
  return list;
}

function makeLinkNode(link, ctx, isImage) {
  return {
    k: 'link',
    href: link.href,
    title: link.title,
    img: isImage,
    // A link's label cannot contain links; an image's label can (the
    // nested constructs feed the alt text).
    kids: scanInline(link.labelText, ctx, !isImage),
  };
}

// The plain text of an inline node list, used for image alt text:
// nested links contribute their text, nested images their own alt.
function altText(list) {
  let out = '';
  for (let node = list.first; node; node = node.next) {
    switch (node.k) {
      case 'text':
      case 'code':
        out += node.s;
        break;
      case 'delim':
        out += node.ch.repeat(node.n);
        break;
      case 'br':
        out += '\n';
        break;
      case 'html':
        break;
      default:
        if (node.kids) out += altText(node.kids);
        break;
    }
  }
  return out;
}

// Cheap pre-check + match for a GFM bare autolink at position i whose
// preceding character allows one. Returns {href, text, end} or null.
function tryGfm(s, i, list) {
  if (s.startsWith('www.', i)) return matchGfmAutolink(s, i, list);
  const c0 = s[i];
  if (c0 === 'h' || c0 === 'H') {
    const head = s.slice(i, i + 8).toLowerCase();
    if (head.startsWith('http://') || head.startsWith('https://')) {
      return matchGfmAutolink(s, i, list);
    }
  }
  // Email: only when an '@' shows up soon with no gap.
  const at = s.indexOf('@', i);
  if (at === -1 || at - i > 64) return null;
  for (let k = i; k < at; k++) {
    const cc = s[k];
    if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '<') return null;
  }
  return matchGfmAutolink(s, i, list);
}

// Scan inline source into a node list (not yet emphasis-processed).
// With noEm set (a failed-link region), emphasis and strikethrough
// delimiters are literal text; everything else scans normally.
function scanInlineRaw(s, ctx, inLink, noEm) {
  const list = new LList();
  // Marked matches emphasis against a copy of the text in which code
  // spans are masked out. The masking pairs backtick runs over the
  // whole text with exact-run semantics — including runs inside link
  // labels — so an opener inside a label can mask emphasis sitting
  // between it and a later run of the same length.
  const maskSpans = [];
  if (s.includes('`')) {
    let j = 0;
    const n0 = s.length;
    while (j < n0) {
      if (s[j] !== '`') { j++; continue; }
      let bs = 0;
      while (s[j - 1 - bs] === '\\') bs++;
      let run = 0;
      while (s[j + run] === '`') run++;
      if (bs % 2 === 1) { j += run; continue; }
      let k = j + run;
      let closeEnd = -1;
      while (k < n0) {
        if (s[k] === '`') {
          let r2 = 0;
          while (s[k + r2] === '`') r2++;
          if (r2 === run) { closeEnd = k + r2; break; }
          k += r2;
        } else k++;
      }
      if (closeEnd !== -1) {
        maskSpans.push([j, closeEnd]);
        j = closeEnd;
      } else {
        j += run;
      }
    }
  }
  // Callers query inMask with non-decreasing positions, so a moving
  // span pointer gives the same answers as a full scan.
  let maskIdx = 0;
  const inMask = (pos) => {
    while (maskIdx < maskSpans.length && pos >= maskSpans[maskIdx][1]) maskIdx++;
    if (maskIdx >= maskSpans.length) return false;
    return pos >= maskSpans[maskIdx][0] && pos < maskSpans[maskIdx][1];
  };
  let buf = '';
  const flush = () => {
    if (buf) {
      list.push({ k: 'text', s: buf });
      buf = '';
    }
  };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush();
        list.push({ k: 'br' });
        i += 2;
        // Spaces at the start of the next line are ignored after a
        // hard break.
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        flush();
        list.push({ k: 'text', s: nx, raw: true });
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === '`') {
      const end = codeSpanEnd(s, i);
      if (end !== -1) {
        flush();
        list.push({ k: 'code', s: codeSpanContent(s, i, end) });
        i = end;
        continue;
      }
      let run = 0;
      while (s[i + run] === '`') run++;
      buf += '`'.repeat(run);
      i += run;
      continue;
    }
    if (c === '<') {
      const tagEnd = matchHtmlTag(s, i);
      if (tagEnd) {
        flush();
        const tagText = s.slice(i, tagEnd);
        // Marked keeps a document-wide "inside an <a> element" state
        // across inline tokenization: an <a> start tag sets it, a
        // </a> end tag clears it, and while it is set, GFM autolinks
        // (bare emails and URLs) are not recognized anywhere.
        if (/^<\/a(?=[\s>])/i.test(tagText)) ctx.inLinkA = false;
        else if (/^<a\s/i.test(tagText)) ctx.inLinkA = true;
        list.push({ k: 'html', s: tagText });
        i = tagEnd;
        continue;
      }
      const auto = matchAngleAutolink(s, i);
      if (auto) {
        flush();
        list.push({ k: 'link', href: auto.href, title: null, img: false, kids: textList(auto.text) });
        i = auto.end;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const link = tryLink(s, i + 1, true, ctx);
      if (link && link.region) {
        if (!noEm) {
          flush();
          const sub = scanInlineRaw(s.slice(i, link.end), ctx, inLink, true);
          for (let nd = sub.first; nd;) {
            const nx = nd.next;
            list.push(nd);
            nd = nx;
          }
          i = link.end;
          continue;
        }
      } else if (link) {
        flush();
        list.push(makeLinkNode(link, ctx, true));
        i = link.end;
        continue;
      }
      buf += '!';
      i++;
      continue;
    }
    if (c === '[' && !inLink) {
      const link = tryLink(s, i, false, ctx);
      if (link && link.region) {
        if (!noEm) {
          flush();
          const sub = scanInlineRaw(s.slice(i, link.end), ctx, inLink, true);
          for (let nd = sub.first; nd;) {
            const nx = nd.next;
            list.push(nd);
            nd = nx;
          }
          i = link.end;
          continue;
        }
      } else if (link) {
        flush();
        list.push(makeLinkNode(link, ctx, false));
        i = link.end;
        continue;
      }
      buf += '[';
      i++;
      continue;
    }
    if (c === '*' || c === '_') {
      let run = 0;
      while (s[i + run] === c) run++;
      if (noEm || inMask(i)) {
        buf += c.repeat(run);
        i += run;
        continue;
      }
      flush();
      const prevCh = i === 0 ? '' : s[i - 1];
      const nextCh = i + run >= n ? '' : s[i + run];
      const f = flanking(c, prevCh, nextCh);
      list.push({ k: 'delim', ch: c, n: run, origN: run, canOpen: f.canOpen, canClose: f.canClose, start: i, closeUsed: 0 });
      i += run;
      continue;
    }
    if (c === '~') {
      let run = 0;
      while (s[i + run] === '~') run++;
      if (noEm) {
        buf += '~'.repeat(run);
        i += run;
        continue;
      }
      if (run <= 2) {
        flush();
        const prevCh = i === 0 ? '' : s[i - 1];
        const nextCh = i + run >= n ? '' : s[i + run];
        list.push({
          k: 'delim', ch: '~', n: run, origN: run,
          canOpen: nextCh !== '' && !isWsCh(nextCh) && nextCh !== '~',
          canClose: prevCh !== '' && !isWsCh(prevCh) && prevCh !== '~',
          start: i, closeUsed: 0,
        });
      } else {
        buf += '~'.repeat(run);
      }
      i += run;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        list.push({ k: 'br' });
        i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      buf += '\n';
      i++;
      continue;
    }
    if (!inLink && !ctx.inLinkA && (c === 'w' || c === 'h' || isAlnumCh(c))) {
      const prevCh = i === 0 ? '' : s[i - 1];
      if (!isAlnumCh(prevCh)) {
        const auto = tryGfm(s, i, list);
        if (auto) {
          flush();
          list.push({ k: 'link', href: auto.href, title: null, img: false, kids: textList(auto.text) });
          i = auto.end;
          continue;
        }
      }
    }
    // Plain text run: consume until the next construct or a position
    // where a GFM autolink might start.
    let j = i + 1;
    while (j < n) {
      const cj = s[j];
      if (cj === '\\' || cj === '`' || cj === '<' || cj === '*' || cj === '_' || cj === '~' || cj === '\n') break;
      if (cj === '[' && !inLink) break;
      if (cj === '!' && s[j + 1] === '[') break;
      if (!inLink && (cj === 'w' || cj === 'h' || isAlnumCh(cj)) && !isAlnumCh(s[j - 1]) && tryGfm(s, j, list)) break;
      j++;
    }
    buf += s.slice(i, j);
    i = j;
  }
  flush();
  return list;
}

/* ------------------------------------------------------------------ */
/* Delimiter processing: strikethrough, emphasis, and rendering        */
/* ------------------------------------------------------------------ */

// Move the nodes strictly between opener and closer into a fresh list.
function gatherKids(list, opener, closer) {
  const kids = new LList();
  let node = opener.next;
  while (node && node !== closer) {
    const nxt = node.next;
    list.detach(node);
    kids.push(node);
    node = nxt;
  }
  return kids;
}

// Pair '~' runs of equal length (1 or 2) into <del> nodes. A run that can
// close looks for the nearest unmatched opener of the same length; the
// content of a formed pair is fully processed (nested del, emphasis).
function processDel(list, s) {
  const delims = [];
  for (let node = list.first; node; node = node.next) {
    if (node.k === 'delim' && node.ch === '~') delims.push(node);
  }
  const stack = [];
  for (const d of delims) {
    if (d.k !== 'delim' || d.ch !== '~' || d.n === 0 || d.moved) continue;
    if (d.canClose) {
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].n === d.n && stack[k].origN === d.n) {
          idx = k;
          break;
        }
      }
      if (idx !== -1) {
        const opener = stack[idx];
        stack.length = idx;
        const kids = gatherKids(list, opener, d);
        for (let kn = kids.first; kn; kn = kn.next) {
          if (kn.k === 'delim') kn.moved = true;
        }
        const del = { k: 'del', kids };
        list.insertBefore(del, d);
        list.detach(opener);
        list.detach(d);
        processKids(kids, s);
        continue;
      }
    }
    if (d.canOpen) stack.push(d);
  }
}

// The CommonMark rule of three, as marked applies it.
function emPairBlocked(opener, closer, s) {
  if (opener.canClose || closer.canOpen) {
    const sum = opener.origN + closer.origN;
    if (sum % 3 === 0 && !(opener.origN % 3 === 0 && closer.origN % 3 === 0)) return true;
  }
  // Marked-specific blocks around '**' openers (probed): a single '*'
  // closer that directly trails a completed emphasis close with only
  // word characters between ('**a *b*c* d**') never takes one star of
  // a '**' opener; and a '**' closer does not pair with a '**' opener
  // whose span holds such an attached single-'*' close with no other
  // delimiter after it ('**a *b*c**').
  if (s && opener.ch === '*' && closer.ch === '*') {
    if (closer.origN === 1 && opener.origN === 2) {
      for (let p = closer.prev; p && p !== opener; p = p.prev) {
        if (p.k === 'delim' && p.ch === '*' && p.pairedClose && p.pairedOpen) {
          const beforeOpen = s[p.pairedOpen.start - 1];
          if (beforeOpen !== undefined && /[\p{L}\p{N}]/u.test(beforeOpen)) break;
          const gap = s.slice(p.start + p.closeUsed, closer.start);
          if (/^[\p{L}\p{N}]+$/u.test(gap)) return true;
          break;
        }
      }
    }
    if (closer.origN === 2 && opener.origN === 2) {
      let attached = null;
      let otherDelim = false;
      for (let p = opener.next; p && p !== closer; p = p.next) {
        if (p.k !== 'delim' || p.ch !== '*') continue;
        if (attached) {
          otherDelim = true;
          break;
        }
        if (p.pairedClose && p.origN === 1 && p.pairedOpen) {
          const beforeOpen = s[p.pairedOpen.start - 1];
          if (beforeOpen !== undefined && /[\p{L}\p{N}]/u.test(beforeOpen)) continue;
          const after = s[p.start + p.closeUsed];
          if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) attached = p;
        }
      }
      if (attached && !otherDelim) return true;
    }
  }
  return false;
}

// The CommonMark delimiter-stack emphasis algorithm over one list level.
function processEmphasis(list, s) {
  const bottoms = new Map();
  let closer = list.first;
  while (closer) {
    if (closer.k !== 'delim' || closer.ch === '~' || !closer.canClose || closer.n === 0) {
      closer = closer.next;
      continue;
    }
    const key = closer.ch + '|' + (closer.origN % 3) + '|' + (closer.canOpen ? 1 : 0);
    const bottom = bottoms.get(key) ?? null;
    let paired = false;
    while (closer.n > 0) {
      let opener = closer.prev;
      let found = null;
      while (opener && opener !== bottom) {
        if (
          opener.k === 'delim' &&
          opener.ch === closer.ch &&
          opener.canOpen &&
          opener.n > 0 &&
          !emPairBlocked(opener, closer, s)
        ) {
          found = opener;
          break;
        }
        opener = opener.prev;
      }
      if (!found) break;
      const use = found.n >= 2 && closer.n >= 2 ? 2 : 1;
      found.n -= use;
      closer.n -= use;
      const em = {
        k: use === 2 ? 'strong' : 'em',
        kids: gatherKids(list, found, closer),
        openD: found,
        openCount: use,
        closeD: closer,
        closeCount: use,
        closeFrom: closer.closeUsed,
        closeTo: closer.closeUsed + use,
      };
      closer.closeUsed += use;
      closer.pairedClose = true;
      closer.pairedOpen = found;
      closer.lastFormed = em;
      list.insertBefore(em, closer);
      paired = true;
    }
    if (!paired) bottoms.set(key, closer.prev);
    closer = closer.next;
  }
  // A closer that formed a strong but was not fully consumed renders
  // its leftover delimiters inside the strong when the strong's
  // content ends with an attached single-'*' emphasis close followed
  // only by word characters ('**a *b*two***' →
  // '<strong>a <em>b</em>two*</strong>'); otherwise the leftover
  // stays outside ('**foo***' → '<strong>foo</strong>*').
  for (let node = list.first; node; node = node.next) {
    if (node.k !== 'delim' || !node.pairedClose || node.n === 0 || !node.lastFormed) continue;
    const outer = node.lastFormed;
    if (outer.k !== 'strong') continue;
    let inner = null;
    for (let child = outer.kids.first; child; child = child.next) {
      if (child.k === 'em' || child.k === 'strong') inner = child;
    }
    if (!inner || inner.k !== 'em' || !inner.closeD) continue;
    if (inner.closeD.ch !== '*' || inner.closeD.origN !== 1 || !inner.openD) continue;
    const beforeOpen = s[inner.openD.start - 1];
    if (beforeOpen !== undefined && /[\p{L}\p{N}]/u.test(beforeOpen)) continue;
    const gap = s.slice(inner.closeD.start + inner.closeTo, node.start);
    if (!/^[\p{L}\p{N}]+$/u.test(gap)) continue;
    outer.kids.push({ k: 'text', s: node.ch.repeat(node.n) });
    node.n = 0;
  }
}

const WORD_ONLY_RE = /^[\p{L}\p{N}][\p{L}\p{N} ]*$/u;

// Marked leaves an outer emphasis pair literal when the pair's own span
// ends with an inner emphasis whose closing delimiter is followed only by
// word characters up to the outer closing delimiter (the *a **b**c* and
// **a *b*c** shapes). Undo such pairs after the CommonMark pass.
function applyAdjustment(list, s) {
  const containers = [];
  const walk = (l) => {
    for (let node = l.first; node; node = node.next) {
      if (node.kids) {
        walk(node.kids);
        if (node.k === 'em' || node.k === 'strong') containers.push([node, l]);
      }
    }
  };
  walk(list);
  for (const [node, l] of containers) {
    if (!node.openD || node.detached) continue;
    let inner = null;
    for (let child = node.kids.first; child; child = child.next) {
      if (child.k === 'em' || child.k === 'strong') inner = child;
    }
    if (!inner || !inner.closeD) continue;
    // The unwrap fires only for an em around a strong (never for a
    // strong around an em) with '*' delimiters on both levels.
    if (node.k !== 'em' || inner.k !== 'strong') continue;
    if (node.openD.ch !== '*' || !inner.openD || inner.openD.ch !== '*') continue;
    const gapStart = inner.closeD.start + inner.closeTo;
    const gapEnd = node.closeD.start + node.closeFrom;
    if (gapEnd <= gapStart) continue;
    const gap = s.slice(gapStart, gapEnd);
    if (!WORD_ONLY_RE.test(gap)) continue;
    // The inner emphasis must also start a fresh word group: the text
    // before its opener inside this span is empty or ends in
    // whitespace. '*foo**bar**baz*' keeps its outer emphasis;
    // '*foo **bar**baz*' loses it.
    const preGap = s.slice(node.openD.start + node.openD.origN, inner.openD.start);
    if (preGap !== '' && !/\s$/.test(preGap)) continue;
    // Unwrap: restore the delimiter counts and splice the children into
    // the containing list in place of the emphasis node.
    node.openD.n += node.openCount;
    node.closeD.n += node.closeCount;
    const first = node.kids.first;
    const last = node.kids.last;
    if (first) {
      first.prev = node.prev;
      last.next = node.next;
      if (node.prev) node.prev.next = first;
      else l.first = first;
      if (node.next) node.next.prev = last;
      else l.last = last;
    } else {
      if (node.prev) node.prev.next = node.next;
      else l.first = node.next;
      if (node.next) node.next.prev = node.prev;
      else l.last = node.prev;
    }
    node.detached = true;
  }
}

// Full processing of a freshly gathered kid list (inside <del>).
function processKids(list, s) {
  processDel(list, s);
  processEmphasis(list, s);
  applyAdjustment(list, s);
}

// Scan and fully process inline source into a node list.
function scanInline(s, ctx, inLink) {
  const list = scanInlineRaw(s, ctx, inLink);
  processKids(list, s);
  return list;
}

// Render a processed node list to HTML.
function renderInlineList(list) {
  let out = '';
  for (let node = list.first; node; node = node.next) {
    switch (node.k) {
      case 'text':
        out += node.raw ? escapeCode(node.s) : escapeText(node.s);
        break;
      case 'code':
        out += '<code>' + escapeCode(node.s) + '</code>';
        break;
      case 'html':
        out += node.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
        if (node.n > 0) out += node.ch.repeat(node.n);
        break;
      case 'em':
        out += '<em>' + renderInlineList(node.kids) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderInlineList(node.kids) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInlineList(node.kids) + '</del>';
        break;
      case 'link': {
        const href = escapeAttr(cleanUrl(node.href));
        const title = node.title != null ? ' title="' + escapeAttr(node.title) + '"' : '';
        if (node.img) {
          out += '<img src="' + href + '" alt="' + escapeAttr(altText(node.kids)) + '"' + title + '>';
        } else {
          out += '<a href="' + href + '"' + title + '>' + renderInlineList(node.kids) + '</a>';
        }
        break;
      }
    }
  }
  return out;
}

// Inline source that the fast engine does not trust itself with: shapes
// outside the generated documents' repertoire, handed to marked instead.
function inlineRisky(s) {
  return (
    /\*{4,}|_{4,}/.test(s) ||
    /\*_|_\*/.test(s) ||
    /~{3,}/.test(s) ||
    /\[\^/.test(s)
  );
}

function inlineHtml(s, ctx, inLink) {
  return renderInlineList(scanInline(s, ctx, inLink));
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Width of the leading whitespace of a line, in columns (a tab advances
// to the next multiple of 4).
function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Expand every tab in a string to spaces, given the column the string
// starts at.
function expandTabs(str, startCol) {
  let col = startCol;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

// Remove up to `cols` columns of leading whitespace from a line whose
// first character sits at column `startCol`. A tab that is only partly
// consumed becomes its remaining width in spaces, and tabs in the
// rest of the line's leading whitespace run are expanded at their
// original columns; tabs later in the line are left for later stages
// to expand at their own base columns.
function stripCols(line, cols, startCol = 0) {
  let col = startCol;
  let removed = 0;
  let i = 0;
  while (i < line.length && removed < cols) {
    const c = line[i];
    if (c === ' ') {
      removed++;
      col++;
      i++;
    } else if (c === '\t') {
      const w = 4 - (col % 4);
      if (w <= cols - removed) {
        removed += w;
        col += w;
        i++;
      } else {
        return ' '.repeat(w - (cols - removed)) + expandLeadingTabs(line.slice(i + 1), col + w);
      }
    } else {
      break;
    }
  }
  return line.slice(i);
}

// Expand tabs in the leading whitespace run of a string to spaces,
// given the column the string starts at. When a container's
// indentation is stripped from a line, a tab that followed the strip
// point keeps its original alignment as spaces.
function expandLeadingTabs(str, startCol) {
  let col = startCol;
  let out = '';
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === ' ') {
      out += c;
      col++;
      i++;
    } else if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else {
      break;
    }
  }
  return out + str.slice(i);
}

// Strip a blockquote marker (up to 3 spaces, '>', and at most one
// following space or tab counted as a single column) from a line.
function stripBqPrefix(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m) return null;
  const startCol = m[0].length;
  const rest = line.slice(startCol);
  if (rest[0] === ' ' || rest[0] === '\t') {
    return expandLeadingTabs(stripCols(rest, 1, startCol), startCol + 1);
  }
  return rest;
}

function matchFenceOpen(line) {
  let sp = 0;
  while (line[sp] === ' ') sp++;
  if (sp > 3) return null;
  const ch = line[sp];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (line[sp + len] === ch) len++;
  if (len < 3) return null;
  const rest = line.slice(sp + len);
  if (ch === '`' && rest.includes('`')) return null;
  return { ch, len, info: rest.trim(), indent: sp };
}

// Manual equivalent of /^ {0,3}<ch>{len,}[ \t]*$/ for a fence closer.
function fenceCloseMatch(line, ch, len) {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let run = 0;
  while (line[i + run] === ch) run++;
  if (run < len) return false;
  let k = i + run;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return k === line.length;
}

function matchAtx(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] ?? '';
  text = text.replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) {
    text = '';
  } else {
    text = text.replace(/[ \t]#+$/, '').replace(/[ \t]+$/, '');
    if (/^#+$/.test(text)) text = '';
  }
  return { level: m[1].length, text };
}

function isHr(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

function setextLevel(line) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_TYPE6_RE = new RegExp('^ {0,3}</?(?:' + HTML_BLOCK_TAGS + ')(?=[\\s/>]|$)', 'i');
const HTML_TYPE1_RE = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i;

// Which HTML block kind a line starts, or 0. Kinds follow CommonMark:
// 1 raw-text elements, 2 comment, 3 processing instruction, 4
// declaration, 5 CDATA, 6 block tags, 7 a complete other tag.
function htmlBlockKind(line) {
  const rest = line.replace(/^ {0,3}/, '');
  if (rest[0] !== '<') return 0;
  const t1 = HTML_TYPE1_RE.exec(line);
  if (t1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  if (HTML_TYPE6_RE.test(line)) return 6;
  // Type 7: a complete tag alone on the line (only trailing blanks).
  const tagEnd = matchHtmlTag(rest, 0);
  if (tagEnd > 0 && /^[ \t]*$/.test(rest.slice(tagEnd))) return 7;
  return 0;
}

// Consume an HTML block starting at line i. Returns {node, end}.
function consumeHtmlBlock(cl, i, b, kind) {
  const L = cl.lines;
  let end;
  if (kind === 1) {
    const tag = HTML_TYPE1_RE.exec(L[i])[1].toLowerCase();
    const closer = '</' + tag;
    end = i;
    while (end < b) {
      const has = L[end].toLowerCase().includes(closer);
      end++;
      if (has) break;
    }
  } else if (kind === 2 || kind === 3 || kind === 4 || kind === 5) {
    const needle = kind === 2 ? '-->' : kind === 3 ? '?>' : kind === 4 ? '>' : ']]>';
    end = i;
    while (end < b) {
      const has = L[end].includes(needle);
      end++;
      if (has) break;
    }
  } else {
    end = i;
    while (end < b && !isBlank(L[end])) end++;
  }
  // Trailing-newline rules (probed against marked): kinds 1-5 keep
  // the newline after their closing line when the following line is
  // not completely empty (a whitespace-only line counts), or at a
  // newline-terminated end. Kinds 6-7 keep nothing when more blocks
  // follow, but a single trailing whitespace-only line at the very
  // end of the context is appended verbatim.
  let nl = '';
  if (kind >= 1 && kind <= 5) {
    if (end < b) nl = L[end] !== '' ? '\n' : '';
    else nl = cl.endNL ? '\n' : '';
  } else {
    if (end >= b) nl = cl.endNL ? '\n' : '';
    else if (end + 1 === b && isBlank(L[end])) nl = '\n' + L[end];
  }
  const text = L.slice(i, end).join('\n') + nl;
  return { node: { type: 'html', text }, end };
}

// Parse a link reference definition starting at line i. Returns
// {label, href, title, end, raw} or null.
function tryParseDef(cl, i, b) {
  const L = cl.lines;
  const line = L[i];
  const indent = /^ {0,3}/.exec(line)[0].length;
  if (line[indent] !== '[') return null;
  // Work over the joined text of a few lines: the label, destination,
  // and title may each continue onto following lines.
  const take = Math.min(b, i + 10);
  const joined = L.slice(i, take).join('\n');
  const close = findClosingBracket(joined, indent);
  if (close === -1 || joined[close + 1] !== ':') return null;
  const label = joined.slice(indent + 1, close);
  // A definition label may not contain an unescaped '['.
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\') {
      k++;
      continue;
    }
    if (label[k] === '[') return null;
  }
  if (labelKey(label) === '') return null;
  let pos = close + 2;
  const skipSep = (allowNl) => {
    while (pos < joined.length && (joined[pos] === ' ' || joined[pos] === '\t')) pos++;
    if (allowNl && joined[pos] === '\n') {
      pos++;
      while (pos < joined.length && (joined[pos] === ' ' || joined[pos] === '\t')) pos++;
      return true;
    }
    return false;
  };
  skipSep(true);
  let destRaw;
  if (joined[pos] === '<') {
    const start = ++pos;
    let ok = false;
    while (pos < joined.length) {
      const c = joined[pos];
      if (c === '\\') {
        pos += 2;
        continue;
      }
      if (c === '\n') return null;
      if (c === '>') {
        ok = true;
        break;
      }
      pos++;
    }
    if (!ok) return null;
    destRaw = joined.slice(start, pos);
    pos++;
  } else {
    const start = pos;
    while (pos < joined.length && !/[\s]/.test(joined[pos])) pos++;
    destRaw = joined.slice(start, pos);
    if (destRaw === '') return null;
  }
  const afterDest = pos;

  const finishDef = (titleRaw, endPos) => {
    const consumed = joined.slice(0, endPos);
    const linesUsed = consumed.split('\n').length;
    return {
      label,
      href: unescapeStr(destRaw),
      title: titleRaw === null ? null : unescapeStr(titleRaw),
      end: i + linesUsed,
      raw: L.slice(i, i + linesUsed).join('\n'),
    };
  };

  // Try to read a title starting at p. Returns {titleRaw, end} or null.
  // A title may span single newlines but not a blank line, and only
  // spaces/tabs may follow it on its closing line.
  const tryTitle = (p) => {
    const q = joined[p];
    if (q !== '"' && q !== "'" && q !== '(') return null;
    const closer = q === '(' ? ')' : q;
    let k = p + 1;
    const start = k;
    while (k < joined.length) {
      const c = joined[k];
      if (c === '\\') {
        k += 2;
        continue;
      }
      if (c === '\n') {
        let m = k + 1;
        while (joined[m] === ' ' || joined[m] === '\t') m++;
        if (m >= joined.length || joined[m] === '\n') return null;
      }
      if (c === closer) {
        let e = k + 1;
        while (joined[e] === ' ' || joined[e] === '\t') e++;
        if (e >= joined.length || joined[e] === '\n') {
          return { titleRaw: joined.slice(start, k), end: e };
        }
        return null;
      }
      k++;
    }
    return null;
  };

  // Variant A: a title, either on the destination's line (after at
  // least one space/tab) or on the next line.
  {
    let p = afterDest;
    let sep = false;
    while (joined[p] === ' ' || joined[p] === '\t') {
      p++;
      sep = true;
    }
    if (joined[p] === '\n') {
      let p2 = p + 1;
      while (joined[p2] === ' ' || joined[p2] === '\t') p2++;
      const t = tryTitle(p2);
      if (t) return finishDef(t.titleRaw, t.end);
    } else if (sep) {
      const t = tryTitle(p);
      if (t) return finishDef(t.titleRaw, t.end);
    }
  }
  // Variant B: no title; the destination's line just ends.
  {
    let p = afterDest;
    while (joined[p] === ' ' || joined[p] === '\t') p++;
    if (p >= joined.length || joined[p] === '\n') return finishDef(null, p);
  }
  return null;
}

function registerDef(ctx, def) {
  const key = labelKey(def.label);
  if (!ctx.defs.has(key)) {
    ctx.defs.set(key, { href: def.href, title: def.title, raw: def.raw });
  }
}

// Split a table row into cells on unescaped pipes (naive: code spans do
// not protect pipes, as marked splits). \| stays in the cell text.
function splitRow(line) {
  const t = line.trim();
  const cells = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '\\' && t[k + 1] === '|') {
      // An escaped pipe is cell content, not a separator; marked hands
      // the bare pipe to the inline layer.
      cur += '|';
      k++;
      continue;
    }
    if (c === '\\' && t[k + 1] === '\\') {
      cur += c + t[k + 1];
      k++;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  if (t.startsWith('|')) cells.shift();
  if (cells.length && cells[cells.length - 1] === '' && t.endsWith('|')) {
    let bs = 0;
    for (let k = t.length - 2; k >= 0 && t[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) cells.pop();
  }
  return cells.map((c) => c.trim());
}

// Validate a header line + delimiter line pair; returns {header, aligns}
// or null.
function tableHeaderPair(headerLine, delimLine) {
  if (isBlank(headerLine) || isBlank(delimLine)) return null;
  const delimCells = splitRow(delimLine);
  if (delimCells.length === 0) return null;
  const aligns = [];
  for (const cell of delimCells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  const header = splitRow(headerLine);
  if (header.length !== delimCells.length) return null;
  if (!delimLine.includes('|') && !delimLine.includes(':') && !headerLine.includes('|')) return null;
  return { header, aligns };
}

function wsPrefixCols(str, startCol) {
  let col = startCol;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col - startCol;
}

// Match a list item start. Returns {ordered, bullet, num, indent,
// contentIndent, rest} or null.
function matchListItem(line) {
  const indent = /^ {0,3}/.exec(line)[0].length;
  const rest = line.slice(indent);
  let m;
  let markerLen;
  let ordered = false;
  let bullet = null;
  let num = 0;
  if ((m = /^([-*+])(?=[ \t]|$)/.exec(rest))) {
    bullet = m[1];
    markerLen = 1;
  } else if ((m = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest))) {
    ordered = true;
    num = parseInt(m[1], 10);
    bullet = m[2];
    markerLen = m[1].length + 1;
  } else {
    return null;
  }
  const markerEnd = indent + markerLen;
  const after = rest.slice(markerLen);
  if (/^[ \t]*$/.test(after)) {
    return { ordered, bullet, num, indent, contentIndent: markerEnd + 1, rest: '' };
  }
  const wsCols = wsPrefixCols(after, markerEnd);
  const ci = wsCols >= 5 ? markerEnd + 1 : markerEnd + wsCols;
  return { ordered, bullet, num, indent, contentIndent: ci, rest: stripCols(after, ci - markerEnd, markerEnd) };
}

// Lines that interrupt a paragraph (CommonMark set; HTML kinds 1-6).
// Inside a list item, marked lets an ordered item of any number
// interrupt a paragraph, not just number 1.
function interruptsParagraph(line, inItem = false) {
  if (matchFenceOpen(line)) return true;
  if (matchAtx(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const li = matchListItem(line);
  if (li && li.rest !== '' && (!li.ordered || li.num === 1 || inItem)) return true;
  const kind = htmlBlockKind(line);
  if (kind >= 1 && kind <= 6) return true;
  return false;
}

function parseParagraph(cl, i, b, ctx) {
  const L = cl.lines;
  const lines = [L[i]];
  let j = i + 1;
  while (j < b) {
    const line = L[j];
    // A line a blockquote gathered lazily is paragraph text by fiat,
    // even when it looks like a heading, list, or setext underline.
    if (cl.lazy && cl.lazy.has(j)) {
      lines.push(line);
      j++;
      continue;
    }
    if (isBlank(line)) {
      // A whitespace-only (but non-empty) final line of a context that
      // does not end with a newline belongs to the paragraph.
      if (line.length > 0 && j === cl.lines.length - 1 && !cl.endNL) {
        lines.push(line);
        j++;
      }
      break;
    }
    const sl = setextLevel(line);
    if (sl) {
      const text = lines.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      return {
        node: { type: 'heading', level: sl, text, raw: L.slice(i, j + 1).join('\n') },
        end: j + 1,
      };
    }
    if (lines.length > 1 && tableHeaderPair(lines[lines.length - 1], line)) {
      return {
        node: { type: 'paragraph', text: lines.slice(0, -1).join('\n'), raw: L.slice(i, j - 1).join('\n') },
        end: j - 1,
      };
    }
    if (interruptsParagraph(line, !!cl.inItem)) break;
    lines.push(line);
    j++;
  }
  return { node: { type: 'paragraph', text: lines.join('\n'), raw: L.slice(i, j).join('\n') }, end: j };
}

function bqLazyOk(inner, line) {
  // Lazy continuation only extends a paragraph, and only directly: the
  // quote's last line must be paragraph text (not blank, not code, and
  // not inside or bounding a fenced code block).
  const last = inner[inner.length - 1];
  if (last === undefined || isBlank(last)) return false;
  let inFence = false;
  let fenceCh = '';
  let fenceLen = 0;
  for (const l of inner) {
    if (inFence) {
      if (fenceCloseMatch(l, fenceCh, fenceLen)) inFence = false;
    } else {
      const fo = matchFenceOpen(l);
      if (fo) {
        inFence = true;
        fenceCh = fo.ch;
        fenceLen = fo.len;
      }
    }
  }
  if (inFence) return false;
  if (matchFenceOpen(last)) return false;
  if (indentCols(last) >= 4) return false;
  return !interruptsParagraph(line);
}

function parseBlockquote(cl, i, b, ctx) {
  const L = cl.lines;
  const inner = [];
  const lazy = new Set();
  let j = i;
  let lastParent = i;
  while (j < b) {
    const line = L[j];
    const stripped = stripBqPrefix(line);
    if (stripped !== null) {
      inner.push(stripped);
      lastParent = j;
      j++;
      continue;
    }
    if (isBlank(line)) break;
    if (inner.length && bqLazyOk(inner, line)) {
      let pushed;
      if (setextLevel(line) > 0) {
        // Marked quirk: a lazy setext underline stays paragraph text;
        // when the paragraph above it already has 2+ lines, the
        // underline gains a 4-space indent.
        let run = 0;
        for (let k = inner.length - 1; k >= 0 && !isBlank(inner[k]); k--) run++;
        pushed = run >= 2 ? '    ' + line.trim() : line;
      } else if (indentCols(line) >= 4) {
        // A lazy line indented by 4+ columns joins the paragraph with
        // those 4 columns removed.
        pushed = stripCols(line, 4);
      } else {
        pushed = line;
      }
      lazy.add(inner.length);
      inner.push(pushed);
      lastParent = j;
      j++;
      continue;
    }
    break;
  }
  const subCl = { lines: inner, endNL: false, lazy };
  const kids = parseBlocks(subCl, 0, inner.length, ctx);
  return { node: { type: 'blockquote', kids, raw: L.slice(i, j).join('\n') }, end: j };
}

// The fence state of the item's lines so far: whether a fenced code
// block is open, and how many content lines it already holds. A
// fence inside a list item only swallows dedented lines once its
// first content line was itself an indented item-content line.
function itemFenceState(itemLines) {
  let inFence = false;
  let fenceCh = '';
  let fenceLen = 0;
  let contentLines = 0;
  for (const l of itemLines) {
    if (inFence) {
      if (new RegExp('^ {0,3}' + fenceCh + '{' + fenceLen + ',}[ \\t]*$').test(l)) inFence = false;
      else contentLines++;
    } else {
      const fo = matchFenceOpen(l);
      if (fo) {
        inFence = true;
        fenceCh = fo.ch;
        fenceLen = fo.len;
        contentLines = 0;
      }
    }
  }
  return { inFence, contentLines };
}

function itemLazyOk(itemLines, line) {
  if (interruptsParagraph(line)) return false;
  let inFence = false;
  let lastText = null;
  for (const l of itemLines) {
    const fo = matchFenceOpen(l);
    if (fo) inFence = !inFence;
    if (!isBlank(l)) lastText = l;
  }
  if (inFence || lastText === null) return false;
  return true;
}

function gatherItem(cl, cur, b, mi, kind, ctx) {
  const L = cl.lines;
  const ci = mi.contentIndent;
  const itemLines = [mi.rest];
  // Incremental equivalent of itemFenceState(itemLines), updated as
  // lines are appended instead of rescanning the item from scratch
  // for every following line.
  let fsIn = false;
  let fsCh = '';
  let fsLen = 0;
  let fsContent = 0;
  const fsFeed = (l) => {
    if (fsIn) {
      if (fenceCloseMatch(l, fsCh, fsLen)) fsIn = false;
      else fsContent++;
    } else {
      const fo = matchFenceOpen(l);
      if (fo) {
        fsIn = true;
        fsCh = fo.ch;
        fsLen = fo.len;
        fsContent = 0;
      }
    }
  };
  fsFeed(mi.rest);
  const pushLine = (l) => {
    itemLines.push(l);
    fsFeed(l);
  };
  const lazyIdx = new Set();
  let lastParent = cur;
  let j = cur + 1;
  let separatedByBlank = false;
  let blankInside = false;

  const finish = (next, endedList) => {
    let lines = itemLines;
    let task = false;
    let checked = false;
    if (lines.length && /^\[( |x|X)\] /.test(lines[0])) {
      task = true;
      checked = lines[0][1] !== ' ';
      lines = lines.slice();
      lines[0] = lines[0].slice(4);
    }
    // Marked trims the trailing blanks of the LAST item's text.
    if (endedList && lines.length) {
      const lastIdx = lines.length - 1;
      const trimmed = lines[lastIdx].replace(/[ \t]+$/, '');
      if (trimmed !== lines[lastIdx]) {
        lines = lines.slice();
        lines[lastIdx] = trimmed;
      }
    }
    const subCl = { lines, endNL: false, lazy: lazyIdx, inItem: true };
    const kids = parseBlocks(subCl, 0, lines.length, ctx);
    // The item makes its list loose when a blank line separates two of
    // its direct child blocks (blank lines inside a nested block do
    // not count), or when a blank line separates it from the next
    // sibling item.
    let loose = separatedByBlank;
    if (!loose && kids.length >= 2) {
      for (let k = 0; k + 1 < kids.length && !loose; k++) {
        const s1 = kids[k].span;
        const s2 = kids[k + 1].span;
        if (!s1 || !s2) continue;
        for (let x = s1[1] + 1; x < s2[0]; x++) {
          if (isBlank(lines[x])) {
            loose = true;
            break;
          }
        }
      }
    }
    return {
      item: { kids, task, checked, loose },
      next,
      lastContent: lastParent,
      endedList,
    };
  };

  // An item that starts empty and is followed by a blank line is a
  // finished empty item: a sibling item after the blank continues the
  // list (loosely); anything else ends it.
  if (mi.rest === '' && cur + 1 < b && isBlank(L[cur + 1])) {
    let k = cur + 1;
    while (k < b && isBlank(L[k])) k++;
    if (k >= b) return finish(k, true);
    const nl = L[k];
    const sm = matchListItem(nl);
    if (sm && sm.ordered === kind.ordered && sm.bullet === kind.bullet && indentCols(nl) < ci) {
      separatedByBlank = true;
      return finish(k, false);
    }
    return finish(k, true);
  }
  if (mi.rest === '' && cur + 1 >= b) {
    return finish(cur + 1, true);
  }

  while (j < b) {
    const line = L[j];
    // While an anchored fenced code block is open inside the item,
    // every line — blank or dedented — is fence content of the item.
    // An unanchored fence (no content line yet) falls through to the
    // normal line rules, so a dedented first line ends the item and
    // leaves the fence empty.
    if (fsIn && fsContent > 0) {
      pushLine(expandLeadingTabs(stripCols(line, ci), ci));
      lastParent = j;
      j++;
      continue;
    }
    if (isBlank(line)) {
      let k = j;
      while (k < b && isBlank(L[k])) k++;
      if (k >= b) return finish(k, true);
      const nl = L[k];
      if (isHr(nl)) return finish(k, true);
      const sm = matchListItem(nl);
      if (sm && sm.ordered === kind.ordered && sm.bullet === kind.bullet && indentCols(nl) < ci) {
        separatedByBlank = true;
        return finish(k, false);
      }
      if (indentCols(nl) >= ci) {
        for (let x = j; x < k; x++) {
          pushLine('');
          lastParent = x;
        }
        blankInside = true;
        j = k;
        continue;
      }
      return finish(k, true);
    }
    if (indentCols(line) >= ci) {
      pushLine(expandLeadingTabs(stripCols(line, ci), ci));
      lastParent = j;
      j++;
      continue;
    }
    if (isHr(line)) return finish(j, true);
    const sm = matchListItem(line);
    if (sm && sm.ordered === kind.ordered && sm.bullet === kind.bullet) {
      return finish(j, false);
    }
    if (sm) return finish(j, true);
    if (itemLazyOk(itemLines, line)) {
      lazyIdx.add(itemLines.length);
      pushLine(indentCols(line) >= 4 ? stripCols(line, 4) : line);
      lastParent = j;
      j++;
      continue;
    }
    return finish(j, true);
  }
  return finish(j, true);
}

function parseListBlock(cl, i, b, ctx) {
  const L = cl.lines;
  const first = matchListItem(L[i]);
  const kind = { ordered: first.ordered, bullet: first.bullet };
  const items = [];
  let loose = false;
  let cur = i;
  let end = i;
  let lastLine = i;
  while (cur < b) {
    const mi = matchListItem(L[cur]);
    if (!mi || mi.ordered !== kind.ordered || mi.bullet !== kind.bullet) break;
    const g = gatherItem(cl, cur, b, mi, kind, ctx);
    items.push(g.item);
    if (g.item.loose) loose = true;
    end = g.next;
    lastLine = g.lastContent;
    cur = g.next;
    if (g.endedList) break;
  }
  return {
    node: { type: 'list', ordered: kind.ordered, start: first.num, loose, items, raw: L.slice(i, end).join('\n') },
    end,
    lastLine,
  };
}

function parseBlocks(cl, a, b, ctx) {
  const L = cl.lines;
  const nodes = [];
  let i = a;
  while (i < b) {
    const line = L[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fo = matchFenceOpen(line);
    if (fo) {
      const content = [];
      let j = i + 1;
      while (j < b) {
        if (fenceCloseMatch(L[j], fo.ch, fo.len)) {
          j++;
          break;
        }
        // Marked dedents backtick-fence content by removing up to
        // (opener indent) leading whitespace characters; tilde-fence
        // content is verbatim.
        let txt = L[j];
        if (fo.ch === '`' && fo.indent > 0) {
          let cut = 0;
          while (cut < fo.indent && (txt[cut] === ' ' || txt[cut] === '\t')) cut++;
          txt = txt.slice(cut);
        }
        content.push(txt);
        j++;
      }
      // Marked drops exactly one trailing blank line of fence content.
      if (content.length && content[content.length - 1] === '') content.pop();
      nodes.push({
        type: 'code',
        lang: fo.info ? unescapeStr(fo.info.split(/\s+/)[0]) : null,
        text: content.length ? content.join('\n') + '\n' : '',
        span: [i, j - 1],
      });
      i = j;
      continue;
    }
    const atx = matchAtx(line);
    if (atx) {
      nodes.push({ type: 'heading', level: atx.level, text: atx.text, raw: line, span: [i, i] });
      i++;
      continue;
    }
    if (isHr(line)) {
      nodes.push({ type: 'hr', span: [i, i] });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const r = parseBlockquote(cl, i, b, ctx);
      r.node.span = [i, r.end - 1];
      nodes.push(r.node);
      i = r.end;
      continue;
    }
    if (matchListItem(line)) {
      const r = parseListBlock(cl, i, b, ctx);
      r.node.span = [i, r.lastLine];
      nodes.push(r.node);
      i = r.end;
      continue;
    }
    const hk = htmlBlockKind(line);
    if (hk) {
      const r = consumeHtmlBlock(cl, i, b, hk);
      r.node.span = [i, r.end - 1];
      nodes.push(r.node);
      i = r.end;
      continue;
    }
    const def = tryParseDef(cl, i, b);
    if (def) {
      registerDef(ctx, def);
      // Definitions render as nothing but still count as a block for
      // list looseness.
      nodes.push({ type: 'def', span: [i, def.end - 1] });
      i = def.end;
      continue;
    }
    if (indentCols(line) >= 4) {
      const content = [];
      let j = i;
      while (j < b) {
        const l2 = L[j];
        if (indentCols(l2) >= 4) {
          content.push(stripCols(l2, 4));
          j++;
          continue;
        }
        if (isBlank(l2)) {
          let k = j;
          while (k < b && isBlank(L[k])) k++;
          if (k < b && indentCols(L[k]) >= 4) {
            for (let x = j; x < k; x++) content.push('');
            j = k;
            continue;
          }
        }
        break;
      }
      while (content.length && content[content.length - 1] === '') content.pop();
      nodes.push({ type: 'code', lang: null, text: content.length ? content.join('\n') + '\n' : '', span: [i, j - 1] });
      i = j;
      continue;
    }
    if (i + 1 < b) {
      const th = tableHeaderPair(L[i], L[i + 1]);
      if (th) {
        const rows = [];
        let j = i + 2;
        // A whitespace-only line of spaces ending in a single tab is
        // still a (empty) row in marked; other blank lines end it.
        while (j < b && (!isBlank(L[j]) || /^ *\t$/.test(L[j])) && !interruptsParagraph(L[j])) {
          const cells = splitRow(L[j]);
          while (cells.length < th.header.length) cells.push('');
          rows.push(cells.slice(0, th.header.length));
          j++;
        }
        nodes.push({ type: 'table', header: th.header, aligns: th.aligns, rows, raw: L.slice(i, j).join('\n'), span: [i, j - 1] });
        i = j;
        continue;
      }
    }
    const para = parseParagraph(cl, i, b, ctx);
    para.node.span = [i, para.end - 1];
    nodes.push(para.node);
    i = para.end;
  }
  return nodes;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function defPrefix(ctx) {
  if (ctx.defPrefix === null) {
    ctx.defPrefix = [...ctx.defs.values()].map((d) => d.raw).join('\n');
  }
  return ctx.defPrefix;
}

// Render a whole block with the vendored marked, with every document
// definition in scope. Used for blocks outside the fast paths.
function fallbackBlock(raw, ctx) {
  const prefix = defPrefix(ctx);
  return marked.parse((prefix ? prefix + '\n\n' : '') + raw + '\n');
}

// Render inline-only text with the vendored marked, stripping the
// paragraph wrapper. Used for table cells and tight list items.
function fallbackInline(text, ctx) {
  const prefix = defPrefix(ctx);
  const out = marked.parse((prefix ? prefix + '\n\n' : '') + text + '\n');
  if (out.startsWith('<p>') && out.endsWith('</p>\n')) return out.slice(3, out.length - 5);
  return out;
}

function checkboxHtml(checked) {
  return checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const node of nodes) out += renderNode(node, ctx);
  return out;
}

function renderNode(node, ctx) {
  switch (node.type) {
    case 'heading': {
      if (inlineRisky(node.text)) return fallbackBlock(node.raw, ctx);
      return '<h' + node.level + '>' + inlineHtml(node.text, ctx, false) + '</h' + node.level + '>\n';
    }
    case 'paragraph': {
      if (inlineRisky(node.text)) return fallbackBlock(node.raw, ctx);
      return '<p>' + inlineHtml(node.text, ctx, false) + '</p>\n';
    }
    case 'code': {
      const lang = node.lang ? ' class="language-' + escapeAttr(node.lang) + '"' : '';
      return '<pre><code' + lang + '>' + escapeCode(node.text) + '</code></pre>\n';
    }
    case 'hr':
      return '<hr>\n';
    case 'html':
      return node.text;
    case 'blockquote':
      return '<blockquote>\n' + renderNodes(node.kids, ctx) + '</blockquote>\n';
    case 'list':
      return renderList(node, ctx);
    case 'table':
      return renderTable(node, ctx);
    default:
      return '';
  }
}

function renderItem(item, loose, ctx) {
  let body = '';
  let firstPara = true;
  for (const child of item.kids) {
    if (child.type === 'paragraph' && item.task && firstPara) {
      const box = checkboxHtml(item.checked) + ' ';
      if (!loose) {
        body += box + (inlineRisky(child.text) ? fallbackInline(child.text, ctx) : inlineHtml(child.text, ctx, false));
      } else if (inlineRisky(child.text)) {
        const fb = fallbackBlock(child.raw, ctx);
        body += fb.startsWith('<p>') ? '<p>' + box + fb.slice(3) : box + fb;
      } else {
        body += '<p>' + box + inlineHtml(child.text, ctx, false) + '</p>\n';
      }
    } else if (child.type === 'paragraph' && !loose) {
      body += inlineRisky(child.text) ? fallbackInline(child.text, ctx) : inlineHtml(child.text, ctx, false);
    } else {
      body += renderNode(child, ctx);
    }
    if (child.type === 'paragraph') firstPara = false;
  }
  if (item.task && firstPara) body = checkboxHtml(item.checked) + ' ' + body;
  return body;
}

function renderList(node, ctx) {
  let out = node.ordered
    ? '<ol' + (node.start !== 1 ? ' start="' + node.start + '"' : '') + '>\n'
    : '<ul>\n';
  for (const item of node.items) {
    out += '<li>' + renderItem(item, node.loose, ctx) + '</li>\n';
  }
  out += node.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

function cellHtml(text, ctx) {
  if (inlineRisky(text)) return fallbackInline(text, ctx);
  return inlineHtml(text, ctx, false);
}

function renderTable(node, ctx) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < node.header.length; c++) {
    const align = node.aligns[c];
    out += '<th' + (align ? ' align="' + align + '"' : '') + '>' + cellHtml(node.header[c], ctx) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (node.rows.length) {
    out += '<tbody>';
    for (const row of node.rows) {
      out += '<tr>\n';
      for (let c = 0; c < node.header.length; c++) {
        const align = node.aligns[c];
        out += '<td' + (align ? ' align="' + align + '"' : '') + '>' + cellHtml(row[c], ctx) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

/**
 * Render a Markdown document to HTML, byte-identical to marked 18.1.3
 * for the competition corpus.
 */
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  let lines;
  let endNL = false;
  if (src === '') {
    lines = [];
  } else {
    endNL = src.endsWith('\n');
    lines = src.split('\n');
    if (endNL) lines.pop();
  }
  const ctx = { defs: new Map(), defPrefix: null, inLinkA: false };
  const nodes = parseBlocks({ lines, endNL }, 0, lines.length, ctx);
  return renderNodes(nodes, ctx);
}
