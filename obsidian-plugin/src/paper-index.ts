/**
 * Builds a per-paper suggestion index from the PDF's extracted text.
 *
 * Term extraction is frequency-based (n-grams + acronyms) so it's resilient
 * to PDF text-layer noise such as doubled-character cover pages.
 */

export type SuggestionKind =
  | "term"
  | "figure"
  | "section"
  | "equation"
  | "citation"
  | "statement"
  | "figure-image"
  | "block";

export interface Suggestion {
  kind: SuggestionKind;
  /** Primary text shown in the list. */
  label: string;
  /** Secondary text (context / expansion / page). */
  detail?: string;
  /** Text inserted into the editor on selection. */
  insert: string;
  /** Ranking score (higher = shown first). */
  score: number;
  /** If set, selecting runs an action instead of inserting text. */
  action?: "extract-equations" | "create-note";
  /** For the create-note action: the Zotero item key + citekey to create. */
  citeItemKey?: string;
  citeKey?: string;
  /** For equations: the number from \tag{…} (e.g. "1", "2.2"), searchable. */
  eqNum?: string;
  /** For equations: normalized LaTeX for symbol matching ("x_t=x_0+..."). */
  searchKey?: string;
  /** 0-based page index in the PDF (drives the zotero:// backlink). */
  page?: number;
  /** Structured payload so `insert` can be re-rendered per the format setting. */
  render?: SuggestionRender;
}

export type SuggestionRender =
  | { type: "statement"; kind: string; label: string; number: string; body: string }
  | { type: "equation"; latex: string; tag: string }
  | { type: "figure"; path: string; caption: string; figKind: string };

export interface PaperIndex {
  attachmentKey: string;
  title: string;
  terms: Suggestion[];
  refs: Suggestion[]; // figures, tables, sections, numbered equations
  equations: Suggestion[]; // LaTeX bodies (filled in by the MinerU extractor)
}

const STOP = new Set(
  ("a an the and or but if then else for to of in on at by with from into over " +
    "under this that these those we our us it its is are was were be been being " +
    "as can will may might should would could not no nor so such than too very " +
    "which who whom whose what when where why how all any both each few more most " +
    "other some only own same s t don just also using used use based given via " +
    "let thus hence therefore however moreover figure table section equation eq " +
    "fig et al ie eg cf per new one two three first second third results result " +
    "paper show shows shown propose proposed present data model method approach " +
    "have has had having does did doing done set sets setting case cases level " +
    "levels make makes made take takes taken see seen get gets got give gives " +
    "value values number numbers form forms part parts thus follow follows " +
    "consider considered denote denotes let us obtain obtained define defined")
    .split(/\s+/)
);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter(
    (w) => w.length <= 30
  );
}

/** Extract acronyms and their expansions: "market microstructure noise (MMN)". */
function extractAcronyms(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([A-Z][A-Za-z]*(?:\s+[A-Za-z]+){0,4})\s*\(([A-Z]{2,6}s?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const expansion = m[1].trim();
    const acr = m[2].replace(/s$/, "");
    // Sanity: acronym roughly matches the initials of the expansion.
    const words = expansion.split(/\s+/).slice(-acr.length);
    if (words.length >= 2 && !out.has(acr)) out.set(acr, expansion);
  }
  // Standalone frequent acronyms without a captured expansion.
  const freq = new Map<string, number>();
  const re2 = /\b([A-Z]{2,6})\b/g;
  while ((m = re2.exec(text)) !== null) {
    const a = m[1];
    freq.set(a, (freq.get(a) ?? 0) + 1);
  }
  for (const [a, n] of freq) {
    if (n >= 4 && !out.has(a)) out.set(a, "");
  }
  return out;
}

function topPhrases(tokens: string[], maxTerms: number): Suggestion[] {
  const uni = new Map<string, number>();
  const bi = new Map<string, number>();
  const tri = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    if (!STOP.has(w)) uni.set(w, (uni.get(w) ?? 0) + 1);

    if (i + 1 < tokens.length) {
      const a = tokens[i], b = tokens[i + 1];
      if (!STOP.has(a) && !STOP.has(b)) {
        const k = `${a} ${b}`;
        bi.set(k, (bi.get(k) ?? 0) + 1);
      }
    }
    if (i + 2 < tokens.length) {
      const a = tokens[i], b = tokens[i + 1], c = tokens[i + 2];
      if (!STOP.has(a) && !STOP.has(c)) {
        const k = `${a} ${b} ${c}`;
        tri.set(k, (tri.get(k) ?? 0) + 1);
      }
    }
  }

  const scored: Array<{ term: string; score: number }> = [];
  // Multi-word phrases are weighted higher than single words.
  for (const [k, n] of tri) if (n >= 3) scored.push({ term: k, score: n * 3 });
  for (const [k, n] of bi) if (n >= 4) scored.push({ term: k, score: n * 2 });
  for (const [k, n] of uni) if (n >= 6) scored.push({ term: k, score: n });

  // Drop unigrams already covered by a higher-scoring phrase.
  scored.sort((a, b) => b.score - a.score);
  const chosen: Array<{ term: string; score: number }> = [];
  const covered = new Set<string>();
  for (const s of scored) {
    if (s.term.includes(" ")) {
      chosen.push(s);
      for (const w of s.term.split(" ")) covered.add(w);
    } else if (!covered.has(s.term)) {
      chosen.push(s);
    }
    if (chosen.length >= maxTerms) break;
  }

  return chosen.map((s) => ({
    kind: "term" as const,
    label: s.term,
    insert: s.term,
    score: s.score,
  }));
}

function extractRefs(text: string): Suggestion[] {
  const seen = new Map<string, Suggestion>();
  const add = (label: string, insert: string, score: number) => {
    if (!seen.has(label)) {
      seen.set(label, { kind: "figure", label, insert, score });
    }
  };

  let m: RegExpExecArray | null;
  const figRe = /\b(Fig(?:ure|\.)?|Table)\s+(\d+)/gi;
  while ((m = figRe.exec(text)) !== null) {
    const kind = /^t/i.test(m[1]) ? "Table" : "Figure";
    add(`${kind} ${m[2]}`, `${kind} ${m[2]}`, 100 - parseInt(m[2], 10));
  }
  const secRe = /\bSection\s+(\d+(?:\.\d+)*)/gi;
  while ((m = secRe.exec(text)) !== null) {
    add(`Section ${m[1]}`, `Section ${m[1]}`, 50);
  }
  const eqRe = /\bEq(?:uation|\.)?\s*\(?(\d+)\)?/gi;
  while ((m = eqRe.exec(text)) !== null) {
    add(`Eq. (${m[1]})`, `Eq. (${m[1]})`, 40 - parseInt(m[1], 10));
  }

  return Array.from(seen.values()).sort((a, b) => {
    if (a.label[0] !== b.label[0]) return a.label.localeCompare(b.label);
    return b.score - a.score;
  });
}

/** Terms whose every token appears in the paper's own author/journal metadata
 *  are almost always running-header noise (author names, journal title). */
function isMetadataNoise(label: string, noise: Set<string>): boolean {
  if (noise.size === 0) return false;
  const toks = label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return toks.length > 0 && toks.some((w) => noise.has(w));
}

export function buildIndexFromText(
  attachmentKey: string,
  title: string,
  fulltext: string,
  noiseWords: Set<string> = new Set()
): PaperIndex {
  const text = fulltext || "";
  // Frequency-based "terms" were removed — too noisy next to real theorems,
  // equations and figures. We only parse figure/section/equation references.
  return {
    attachmentKey,
    title,
    terms: [],
    refs: extractRefs(text),
    equations: [],
  };
}

/** Build the noise-word set from an item's authors + publication title. */
export function metadataNoiseWords(
  creators: Array<{ lastName?: string; firstName?: string }>,
  publicationTitle?: string | null
): Set<string> {
  const noise = new Set<string>();
  const add = (s: string) => {
    for (const w of s.toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 2) noise.add(w);
    }
  };
  for (const c of creators ?? []) {
    if (c.lastName) add(c.lastName);
    if (c.firstName) add(c.firstName);
  }
  if (publicationTitle) add(publicationTitle);
  // Common journal-title words shouldn't nuke real terms if a paper is about them.
  for (const w of ["journal", "review", "proceedings", "conference", "letters"]) {
    noise.add(w);
  }
  return noise;
}

function dedupeByLabel(items: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const it of items) {
    const key = it.label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

/**
 * Normalize LaTeX (or a query) for symbol-based matching: lowercase and drop
 * whitespace, braces, backslashes and $, plus any \tag{…}. This makes "X_t"
 * match "X _ { t }" and "\sigma" match a typed "sigma".
 */
export function normalizeMath(s: string): string {
  return s
    .toLowerCase()
    .replace(/\\tag\{[^}]*\}/g, "")
    .replace(/[\s{}$\\]/g, "");
}

/** Filter + rank an index's suggestions against a typed query. */
export function filterSuggestions(
  index: PaperIndex | null,
  query: string,
  limit = 40
): Suggestion[] {
  if (!index) return [];
  const q = query.toLowerCase().trim();
  const qNum = q.replace(/[()\s]/g, ""); // "(1)" / "1" / "2.2" -> "1" / "2.2"
  const qNorm = normalizeMath(query); // symbol form of the query, e.g. "x_t"
  const pool = [...index.equations, ...index.terms, ...index.refs];

  const matches: Array<{ s: Suggestion; rank: number }> = [];
  for (const s of pool) {
    if (!q) {
      matches.push({ s, rank: s.score });
      continue;
    }
    // Exact equation-number match: ";;1", ";;(1)", ";;2.2" -> that equation.
    if (s.eqNum && qNum && s.eqNum.toLowerCase() === qNum) {
      matches.push({ s, rank: 1e7 + s.score });
      continue;
    }
    // Plain substring match on the display label (terms, refs, eq labels).
    const idx = s.label.toLowerCase().indexOf(q);
    if (idx !== -1) {
      const rank = (idx === 0 ? 1e6 : 0) + s.score - idx;
      matches.push({ s, rank });
      continue;
    }
    // Symbol-based match on the equation's normalized LaTeX ("X_t" -> "x_t"),
    // so structural noise like \begin{array} never blocks a match.
    if (s.searchKey && qNorm) {
      const ki = s.searchKey.indexOf(qNorm);
      if (ki !== -1) {
        const rank = (ki === 0 ? 5e5 : 0) + s.score - ki;
        matches.push({ s, rank });
      }
    }
  }

  matches.sort((a, b) => b.rank - a.rank);
  return matches.slice(0, limit).map((m) => m.s);
}
