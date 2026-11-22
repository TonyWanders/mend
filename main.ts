// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits), with three-tier
// line matching, all-or-nothing writes and exact stdout/exit codes. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers                            */
/* ------------------------------------------------------------------ */

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  return /^[ \t]*/.exec(s)![0]; // `*` always matches, so exec never returns null
}

/** Positions where O occurs in `lines` at `tier`, starting at or after `from`. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0..2, or 0 only when strict) at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const positions = occurrencesAt(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return { tier: 0, positions: [] };
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  ctxIdx: number; // index into O of the context line, when ctx
}

/**
 * Replace O at `pos` with N in `lines`. Context lines are written as the file's own
 * matched lines; at tier 2 every other non-blank line of N starting with O's first
 * line's leading whitespace has that prefix replaced by the file's first matched
 * line's leading whitespace.
 */
function replaceAt(lines: string[], o: string[], n: NLine[], tier: number, pos: number): string[] {
  const out = lines.slice(0, pos);
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = lines.length > pos ? leadingWs(lines[pos]!) : '';
  for (const item of n) {
    if (item.ctx) {
      out.push(lines[pos + item.ctxIdx]!);
    } else if (tier === 2 && item.text !== '' && item.text.trim() !== '' && item.text.startsWith(p)) {
      out.push(f + item.text.slice(p.length));
    } else {
      out.push(item.text);
    }
  }
  for (let i = pos + o.length; i < lines.length; i++) out.push(lines[i]!);
  return out;
}

/** N lines made only of new text (no context lines), e.g. for SEARCH/REPLACE. */
function newOnly(texts: string[]): NLine[] {
  return texts.map((t) => ({ text: t, ctx: false, ctxIdx: -1 }));
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (starter code, kept)                          */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Shared hunk/chunk body lines                                        */
/* ------------------------------------------------------------------ */

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** Split a hunk/chunk body into O lines and N lines (section 5). */
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, ctxIdx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: false, ctxIdx: -1 });
    }
    // '\' lines only mark the line before them; they add no line.
  }
  return { o, n };
}

/**
 * Whether a `\` line follows the body's last context or `+` line: the
 * no-newline-at-end-of-file marker for the hunk/chunk's result.
 */
function noeolAfterLast(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  headerOld: string | null;
  headerNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** Path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function uniPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): number {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return Number(m[1]);
}

/** Body lines from `start` until the first non-body line, diff line, or ---/+++ pair. */
function parseHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+' | '\\'), text: l.slice(1) });
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  return { body, next: i };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, headerOld: null, headerNew: null, renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        // Part of this section's header, not a new section.
        cur.headerOld = uniPath(line.slice(4));
        cur.headerNew = uniPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      cur = { diffOld: null, diffNew: null, headerOld: uniPath(line.slice(4)), headerNew: uniPath(lines[i + 1]!.slice(4)), renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseHunkHeader(line, i);
      const { body, next } = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a, body });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity/dissimilarity index, Index: and anything else: ignored.
      i++;
      continue;
    }
    // After hunks: anything that is not a new section or hunk is ignored (prose, fences).
    i++;
  }
  return sections;
}

/** Apply one section's hunks to a document; throws Fail('no-match', path) on a hunk failure. */
function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let lines = doc.lines.slice();
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const ins = n.map((x) => x.text);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !noeolAfterLast(h.body);
    } else {
      const { tier, positions } = findTier(lines, o, strict, 0);
      if (positions.length === 0) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === lines.length;
      lines = replaceAt(lines, o, n, tier, best);
      if (runsToEnd) final = !noeolAfterLast(h.body);
    }
    d += n.length - o.length;
  }
  return { lines, br: doc.br, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      // Path precedence (section 6): ---/+++ pair, then rename from/to, then diff --git.
      const oldP = sec.headerOld ?? sec.renameFrom ?? sec.diffOld;
      const newP = sec.headerNew ?? sec.renameTo ?? sec.diffNew;
      const oldIsNull = oldP === '/dev/null';
      const newIsNull = newP === '/dev/null';
      const isCreate = oldIsNull || sec.newFile;
      const isDelete = !isCreate && (newIsNull || sec.deletedFile);
      const oldPath = oldP === null ? '' : oldP;
      const newPath = newP === null ? '' : newP;
      if (isCreate) {
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const plus: string[] = [];
        let noeol = false;
        for (const h of sec.hunks) {
          for (let j = 0; j < h.body.length; j++) {
            const b = h.body[j]!;
            if (b.kind === '+') {
              plus.push(b.text);
              noeol = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === '\\';
            }
          }
        }
        tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        // Move.
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const doc = applyHunks(parseDoc(before), sec.hunks, strict, oldPath);
        tree.now.set(newPath, serializeDoc(doc));
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
        return;
      }
      // Change of the one path.
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const doc = applyHunks(parseDoc(before), sec.hunks, strict, oldPath);
      tree.now.set(oldPath, serializeDoc(doc));
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = searchLine - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      let sep = -1;
      for (let j = searchLine + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '=======') {
          sep = j;
          break;
        }
      }
      if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      let end = -1;
      for (let j = sep + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
      if (end === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
      const oldLines = lines.slice(searchLine + 1, sep);
      const newLines = lines.slice(sep + 1, end);
      edits.push(((p, o, n) => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (o.length === 0) {
            if (tree.get(p) !== null) throw new Fail('exists', p);
            tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
            return;
          }
          const cur = tree.get(p);
          if (cur === null) throw new Fail('missing', p);
          const doc = parseDoc(cur);
          const { tier, positions } = findTier(doc.lines, o, strict, 0);
          if (positions.length === 0) throw new Fail('no-match', p);
          if (positions.length > 1) throw new Fail('ambiguous', p);
          tree.now.set(p, serializeDoc({ ...doc, lines: replaceAt(doc.lines, o, newOnly(n), tier, positions[0]!) }));
        };
      })(path, oldLines, newLines));
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                              */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  hasAnchor: boolean;
  eof: boolean;
  body: BodyLine[];
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i;
    i++;
    // Collect the section's lines up to the next section start or End Patch.
    const secLines: number[] = [];
    while (i < last && !isV4aSectionStart(lines[i]!)) {
      secLines.push(i);
      i++;
    }
    // Blank lines at the end of a section are not part of it.
    while (secLines.length > 0 && blank(lines[secLines[secLines.length - 1]!]!)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const li of secLines) {
        const sl = lines[li]!;
        if (sl === '') fileLines.push('');
        else if (sl.startsWith('+')) fileLines.push(sl.slice(1));
        else throw new Exit2(`error: parse ${li + 1}`);
      }
      edits.push(((p, fl) => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
        };
      })(path, fileLines));
    } else if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]! + 1}`);
      edits.push(((p) => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        };
      })(path));
    } else {
      // Update File.
      let moveTo: string | null = null;
      let idx = 0;
      if (secLines.length > 0 && lines[secLines[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[secLines[0]!]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let firstChunk = true;
      for (; idx < secLines.length; idx++) {
        const li = secLines[idx]!;
        const sl = lines[li]!;
        if (sl.startsWith('@@')) {
          if (curChunk !== null) chunks.push(curChunk);
          curChunk = { anchor: sl.slice(2).trim(), hasAnchor: true, eof: false, body: [] };
          firstChunk = false;
          continue;
        }
        if (sl === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${li + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          firstChunk = false;
          continue;
        }
        if (sl.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${li + 1}`);
        if (sl === '' || sl[0] === ' ' || sl[0] === '-' || sl[0] === '+') {
          if (curChunk === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${li + 1}`);
            curChunk = { anchor: null, hasAnchor: false, eof: false, body: [] };
            firstChunk = false;
          }
          if (sl === '') curChunk.body.push({ kind: ' ', text: '' });
          else curChunk.body.push({ kind: sl[0] as ' ' | '-' | '+', text: sl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${li + 1}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      edits.push(((p, mt, chs) => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
          const before = tree.get(p);
          if (before === null) throw new Fail('missing', p);
          if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
          const doc = parseDoc(before);
          let curLines = doc.lines.slice();
          let cursor = 0;
          for (const ch of chs) {
            if (ch.hasAnchor) {
              const { positions } = findTier(curLines, [ch.anchor!], strict, cursor);
              if (positions.length === 0) throw new Fail('no-match', p);
              cursor = positions[0]! + 1;
            }
            const { o, n } = splitBody(ch.body);
            if (o.length === 0) {
              const at = ch.eof ? curLines.length : cursor;
              const ins = n.map((x) => x.text);
              curLines.splice(at, 0, ...ins);
              cursor = at + ins.length;
            } else {
              const { tier, positions } = findTier(curLines, o, strict, cursor);
              let pos = -1;
              for (const cand of positions) {
                if (ch.eof && cand + o.length !== curLines.length) continue;
                pos = cand;
                break;
              }
              if (pos === -1) throw new Fail('no-match', p);
              curLines = replaceAt(curLines, o, n, tier, pos);
              cursor = pos + n.length;
            }
          }
          const out: FileDoc = { lines: curLines, br: doc.br, final: doc.final };
          if (mt !== null) {
            tree.now.set(mt, serializeDoc(out));
            tree.now.set(p, null);
            tree.moves.push([p, mt]);
          } else {
            tree.now.set(p, serializeDoc(out));
          }
        };
      })(path, moveTo, chunks));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Sections 1, 2 and 10: invocation, output and exit codes             */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M by path, R by the new path, all in byte order of that key.
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
