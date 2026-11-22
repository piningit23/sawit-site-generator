// A fast drop-in for makefun-site 1.0.0, written from its README spec.
// run(input) returns the same output tree makefun-site 1.0.0's build returns,
// byte for byte, for every input. No dependencies, no I/O, no clock, no
// randomness: the answer is a function of the input alone.
//
// Speed comes from doing the same work with less of it: HTML escaping that
// scans for special characters instead of replacing per character, slug
// memoisation with an ASCII fast path, a hand-rolled Markdown lexer that
// classifies lines by their first characters instead of running a regex
// per line, a single-pass inline renderer that flushes plain runs at once,
// and a template interpreter over compact node arrays that renders into one
// shared output array.

/** Code-unit order (never the locale's). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A source path's directory, "" at the root. */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- HTML escape

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const SPECIAL_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  SPECIAL_RE.lastIndex = 0;
  let m = SPECIAL_RE.exec(text);
  if (m === null) return text;
  const parts = [];
  let last = 0;
  do {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(ESC_MAP[m[0]]);
    last = m.index + 1;
  } while ((m = SPECIAL_RE.exec(text)) !== null);
  if (last < text.length) parts.push(text.slice(last));
  return parts.join('');
}

// ---------------------------------------------------------------- slugs

const MARK_RE = /\p{M}/gu;
const NON_ASCII_RE = /[^\x00-\x7F]/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text`, computed the slow way (NFKD, marks dropped, runs of
 *  non-alphanumerics one "-", at most 64 chars, "untitled" when empty). */
function slugifyCompute(text) {
  // Pure ASCII normalises to itself and holds no combining marks.
  const plain = NON_ASCII_RE.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** The slug of `text`, memoised in this run's cache. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyCompute(text);
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // JavaScript whitespace, inlined: \t \n \v \f \r space and the Unicode spaces.
    const ws =
      c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
      c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (const p of parts) {
        const t = p.trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) { ok = false; break; }
        }
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on "-"
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false; // may not close on "-"
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** `line` with spaces and tabs at its end dropped. */
function stripTrailing(line) {
  let e = line.length;
  while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return e === line.length ? line : line.slice(0, e);
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFM(text) {
  const firstNl = text.indexOf('\n');
  if ((firstNl === -1 ? text : text.slice(0, firstNl)) !== '---') return { error: 'no front matter' };
  // Collect the front-matter lines (between the opening --- and the next
  // line that is exactly ---), and where the body starts.
  const fmLines = [];
  let bodyStart = -1;
  let start = firstNl === -1 ? text.length : firstNl + 1;
  while (start <= text.length) {
    let e = text.indexOf('\n', start);
    if (e === -1) e = text.length;
    const line = text.slice(start, e);
    if (line === '---') {
      bodyStart = e < text.length ? e + 1 : text.length;
      break;
    }
    fmLines.push(line);
    if (e === text.length) break;
    start = e + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (line === '') continue;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // blank, or a "#" comment
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = stripTrailing(line.slice(k + 2));
    else return { error: `line ${j + 2} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** Whether `line` holds only spaces and tabs (or nothing). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isSpaceTab(c) {
  return c === 32 || c === 9;
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < n && isSpaceTab(line.charCodeAt(i))) i++;
  return i === n ? lang : null;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let i = 3;
  while (i < line.length && isSpaceTab(line.charCodeAt(i))) i++;
  return i === line.length;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (!isSpaceTab(line.charCodeAt(d))) return null;
  let i = d;
  while (isSpaceTab(line.charCodeAt(i))) i++;
  let e = line.length;
  while (e > i && isSpaceTab(line.charCodeAt(e - 1))) e--;
  if (e === i) return null;
  return { depth: d, text: line.slice(i, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  let i = 3;
  while (i < line.length && isSpaceTab(line.charCodeAt(i))) i++;
  return i === line.length;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null. */
function orderedOf(line) {
  let d = 0;
  while (d < 9) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

const WS_RE = /\s/;

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let k = 0;
  while (line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !WS_RE.test(line[k]);
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (Number.isNaN(c)) return true;
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dirParts` (its
 *  segments), or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A link target's href, from the source `lc` names; broken links are reported once. */
function resolveLink(lc, target) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(lc.dirParts, rel);
  if (path !== null) {
    const s = lc.bySource.get(path);
    if (s !== undefined) return s.url + frag;
    if (lc.statics.has(path)) return lc.base + '/' + path + frag;
  }
  lc.broken.add(`broken-link ${lc.srcPath} -> ${target}`);
  return target;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  let j = from;
  while (j <= n - wlen) {
    if (s[j] === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  let j = from;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) { j += 2; continue; }
    if (c !== '*') { j++; continue; }
    if (s[j + 1] === '*') { j += 2; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; links resolve through `lc`. The next character that
 *  can open a construct or needs escaping is found with one regex scan per
 *  plain run; the regex is fresh per call, so a nested render cannot move
 *  another call's scan. A plain run holds no such character and is written
 *  as it stands. */
function inline(s, lc) {
  const parts = [];
  const n = s.length;
  const next = /[\\`*\[&<>"']/g;
  let i = 0;
  while (i < n) {
    next.lastIndex = i;
    const m = next.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) parts.push(s.slice(i, j));
    if (j === n) break;
    const c = s[j];
    const html = ESC_MAP[c];
    if (html !== undefined) { parts.push(html); i = j + 1; continue; }
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      parts.push(ESC_MAP[s[j + 1]] ?? s[j + 1]);
      i = j + 2;
      continue;
    }
    if (c === '`') {
      const e = s.indexOf('`', j + 1);
      if (e > j + 1) {
        parts.push(`<code>${esc(s.slice(j + 1, e))}</code>`);
        i = e + 1;
      } else { parts.push('`'); i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const e = findUnescaped(s, '**', j + 2);
        if (e > j + 2) {
          parts.push(`<strong>${inline(s.slice(j + 2, e), lc)}</strong>`);
          i = e + 2;
        } else { parts.push('**'); i = j + 2; }
        continue;
      }
      const e = findSingleStar(s, j + 1);
      if (e > j + 1) {
        parts.push(`<em>${inline(s.slice(j + 1, e), lc)}</em>`);
        i = e + 1;
      } else { parts.push('*'); i = j + 1; }
      continue;
    }
    if (c === '[') {
      const kk = findUnescaped(s, ']', j + 1);
      const mm = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
      const target = mm === -1 ? '' : s.slice(kk + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        parts.push(`<a href="${esc(resolveLink(lc, target))}">${inline(s.slice(j + 1, kk), lc)}</a>`);
        i = mm + 1;
      } else { parts.push('['); i = j + 1; }
      continue;
    }
    parts.push('\\');
    i = j + 1; // a backslash before a character it does not escape: itself
  }
  return parts.join('');
}

/**
 * `src` rendered: its HTML, its table of contents (every level 2 and 3
 * heading) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMd(src, lc) {
  const lines = src.split('\n');
  const parts = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // Only a blank line starts with a space or tab and holds nothing else;
    // an empty line ends a block too. Any other line is classified by its
    // first character, so plain paragraph lines skip the other checks.
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
    } else if (line.length === 0) { i++; continue; }
    const lang = c0 === 96 ? fenceOpen(line) : null;
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      parts.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>`);
      for (const bl of body) {
        parts.push(esc(bl));
        parts.push('\n');
      }
      parts.push('</code></pre>\n');
      continue;
    }
    const hd = c0 === 35 ? headingOf(line) : null;
    if (hd !== null) {
      const id = uniqSlug(slugify(hd.text, lc.slugCache), ids);
      const html = inline(hd.text, lc);
      parts.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) { parts.push('<hr>\n'); i++; continue; }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const keptLines = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') keptLines.push(t);
      }
      if (keptLines.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push(`<blockquote>\n<p>${inline(keptLines.join('\n'), lc)}</p>\n</blockquote>\n`);
      continue;
    }
    const bText = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
    const o = bText === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (bText !== null || o !== null) {
      const isOrd = o !== null;
      const items = [];
      while (i < n) {
        if (isOrd) {
          const m = orderedOf(lines[i]);
          if (m !== null) { items.push([trimLine(m.text)]); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && o.start !== 1 ? `<ol start="${o.start}">` : `<${tag}>`;
      parts.push(`${open}\n`);
      for (const it of items) parts.push(`<li>${inline(it.join('\n'), lc)}</li>\n`);
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), lc);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src` holds only spaces or tabs between `a` and `b`. */
function onlySpacesTabs(src, a, b) {
  for (let k = a; k < b; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = onlySpacesTabs(src, lineStart, open) && onlySpacesTabs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Node arrays: [0, text] text | [1, path] escaped var | [2, path] raw var |
// [3, not, path, then, else|null] if | [4, name, path, body] for | [5, name] include

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const rootBody = [];
  const stack = [{ kind: 'root', kindName: 'root', node: null, body: rootBody }];
  let body = rootBody;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') { body.push([0, tok.text]); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push([tok.t === 'var' ? 1 : 2, tok.path]); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [4, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push({ kind: 'for', kindName: 'for', node, body: node[3] });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [3, m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push({ kind: 'if', kindName: 'if', node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.body = top.node[4];
      body = top.node[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push([5, m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kindName} is not closed`);
  return rootBody;
}

/** The value at a one-name path in the scope chain. */
function lk1(s, a) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  return s === null ? undefined : s.vars[a];
}

/** The value at a two-name path in the scope chain. */
function lk2(s, a, b) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}

/** The value at a three-name path in the scope chain. */
function lk3(s, a, b, c) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}

/** The value at `path` in the scope chain, by its length. */
function lkPath(s, path) {
  if (path.length === 1) return lk1(s, path[0]);
  if (path.length === 2) return lk2(s, path[0], path[1]);
  if (path.length === 3) return lk3(s, path[0], path[1], path[2]);
  return lookup(s, path);
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. */
function renderNodes(nodes, scope, depth, out, templates) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    switch (n[0]) {
      case 0:
        out.push(n[1]);
        break;
      case 1:
        out.push(esc(textOf(lkPath(scope, n[1]))));
        break;
      case 2:
        out.push(textOf(lkPath(scope, n[1])));
        break;
      case 3: {
        const v = truthy(lkPath(scope, n[2]));
        const branch = v !== n[1] ? n[3] : n[4];
        if (branch !== null) renderNodes(branch, scope, depth, out, templates);
        break;
      }
      case 4: {
        const xs = lkPath(scope, n[2]);
        if (!Array.isArray(xs)) break;
        const name = n[1];
        const body = n[3];
        const len = xs.length;
        for (let j = 0; j < len; j++) {
          const vars = { [name]: xs[j], loop: { index: j + 1, first: j === 0, last: j === len - 1, length: len } };
          renderNodes(body, { vars, parent: scope }, depth, out, templates);
        }
        break;
      }
      case 5: {
        const t = templates.get(n[1]);
        if (t !== undefined && depth < 8) renderNodes(t, scope, depth + 1, out, templates);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A source's tags, each slug once, in its own order. */
function ownTagNames(s, cache) {
  const seen = new Set();
  const out = [];
  const names = s.data.tags ?? [];
  for (const name of names) {
    const slug = slugify(name, cache);
    if (!seen.has(slug)) { seen.add(slug); out.push(name); }
  }
  return out;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer),
    older: linkOf(s.older),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();

  // 2. Templates, parsed in code-unit order of name; one that does not
  // parse is reported and left out.
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(cmp);
  for (const name of tNames) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const base = stripTrailingSlashes(input.site.base_url);

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text, dir: dirOf(f.path) });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 3. Front matter, in order: refused, generator-owned, dateless post,
  // unknown layout, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/') || s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: ${s.path.startsWith('tags/') ? 'tags' : 'page'}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks: each page's slug, unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : s.dir;
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    s.newer = null;
    s.older = null;
    bySource.set(s.path, s);
  }

  // 5. Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const lc = { dirParts: s.dir === '' ? [] : s.dir.split('/'), bySource, statics: staticPaths, base, broken, srcPath: s.path, slugCache };
    const md = renderMd(s.body, lc);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 6. Collections: posts newest first, equal dates by slug; neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 7. Tags: grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p, slugCache)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s, slugCache).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 8. Layouts: every page through its layout, the index and tag pages.
  for (const s of kept) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, out, templates);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every line reported above, sorted, then the counts.
  const lines = [...report, ...broken].sort(cmp);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** `site.base_url` with its trailing slashes dropped. */
function stripTrailingSlashes(url) {
  let e = url.length;
  while (e > 0 && url.charCodeAt(e - 1) === 47) e--;
  return e === url.length ? url : url.slice(0, e);
}
