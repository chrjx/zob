import { requestUrl } from "obsidian";
import { unzipSync } from "fflate";
import { promises as fs } from "fs";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { URL } from "url";
import { basename } from "path";

export interface ExtractedEquation {
  latex: string;
  /** 0-based page index, if known. */
  page: number | null;
}

export interface ExtractedFigure {
  kind: "figure" | "table" | "chart";
  /** Cropped image bytes from the result zip. */
  data: Uint8Array;
  ext: string;
  caption: string | null;
  page: number | null;
}

export interface ExtractedStatement {
  /** "Theorem" | "Definition" | "Lemma" | "Assumption" | … */
  kind: string;
  /** "1", "2.1", or null. */
  number: string | null;
  /** Full statement text (inline $…$; trailing display equations appended). */
  text: string;
  page: number | null;
}

export interface ExtractedBlock {
  /** Nearest preceding section heading, if any. */
  heading: string | null;
  /** Paragraph text with its trailing display equations appended as $$…$$. */
  text: string;
  page: number | null;
}

export interface ExtractedContent {
  equations: ExtractedEquation[];
  figures: ExtractedFigure[];
  statements: ExtractedStatement[];
  /** Prose blocks (paragraph + its equations) for semantic block import. */
  blocks: ExtractedBlock[];
}

export type ProgressFn = (msg: string) => void;

/**
 * A pluggable PDF content extractor. MinerU (cloud) is the first implementation;
 * a local/offline backend can be added behind this same interface without
 * touching the rest of the plugin.
 */
export interface Extractor {
  /** Short backend id for logs/UI (e.g. "MinerU"). */
  readonly name: string;
  /** Whether the backend has what it needs to run (token, binary, …). */
  isConfigured(): boolean;
  /**
   * Upload/parse a PDF into structured content. `pageRanges` (e.g. "1-200")
   * limits extraction to those pages; reported pages are made absolute.
   */
  extract(
    pdfPath: string,
    onProgress?: ProgressFn,
    pageRanges?: string
  ): Promise<ExtractedContent>;
}

export interface MineruOptions {
  enableFormula?: boolean;
  enableTable?: boolean;
  language?: string;
  isOcr?: boolean;
}

const API = "https://mineru.net/api/v4";

/** First page number in a range spec ("3-5" -> 3, "10,20-30" -> 10). */
export function rangeStartPage(spec: string): number {
  const m = spec.match(/\d+/);
  return m ? parseInt(m[0], 10) : 1;
}

/** Shift every page index in a result by `off` (relative -> absolute). */
function offsetPages(c: ExtractedContent, off: number): void {
  const bump = (p: number | null) => (typeof p === "number" ? p + off : p);
  for (const e of c.equations) e.page = bump(e.page);
  for (const s of c.statements) s.page = bump(s.page);
  for (const f of c.figures) f.page = bump(f.page);
  for (const b of c.blocks) b.page = bump(b.page);
}

/**
 * Extracts equations (as LaTeX) from a local PDF via the MinerU cloud API.
 * Flow: request a presigned upload URL -> PUT the PDF -> poll the batch task
 * -> download the result zip -> parse content_list.json (or the markdown).
 *
 * Note: the PDF is uploaded to MinerU's servers.
 */
export class MineruExtractor implements Extractor {
  readonly name = "MinerU";
  constructor(private token: string, private opts: MineruOptions = {}) {}

  isConfigured(): boolean {
    return !!this.token;
  }

  private apiHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async extract(
    pdfPath: string,
    onProgress: ProgressFn = () => {},
    pageRanges?: string
  ): Promise<ExtractedContent> {
    if (!this.token) throw new Error("MinerU API token is not set.");

    const bytes = new Uint8Array(await fs.readFile(pdfPath));
    const name = basename(pdfPath);

    const file: Record<string, unknown> = {
      name,
      is_ocr: this.opts.isOcr ?? false,
    };
    // page_ranges is a per-file field (not top-level).
    if (pageRanges) file.page_ranges = pageRanges;

    onProgress("requesting upload URL");
    const batch = await requestUrl({
      url: `${API}/file-urls/batch`,
      method: "POST",
      headers: this.apiHeaders(),
      throw: false,
      body: JSON.stringify({
        enable_formula: this.opts.enableFormula ?? true,
        enable_table: this.opts.enableTable ?? true,
        language: this.opts.language ?? "en",
        files: [file],
      }),
    });
    if (batch.status !== 200 || batch.json?.code !== 0) {
      throw new Error(
        `MinerU upload request failed (HTTP ${batch.status}): ${JSON.stringify(
          batch.json ?? batch.text
        )}`
      );
    }
    const batchId: string = batch.json.data.batch_id;
    const uploadUrl: string = batch.json.data.file_urls[0];

    onProgress("uploading PDF");
    const putStatus = await putBinary(uploadUrl, bytes);
    if (putStatus < 200 || putStatus >= 300) {
      throw new Error(`PDF upload failed (HTTP ${putStatus}).`);
    }

    onProgress("processing (this can take ~1 min)");
    const zipUrl = await this.pollForZip(batchId, name, onProgress);

    onProgress("downloading result");
    const zipRes = await requestUrl({ url: zipUrl, method: "GET", throw: false });
    const content = parseContentFromZip(new Uint8Array(zipRes.arrayBuffer));

    // MinerU numbers a page-ranged result from 0; shift back to absolute pages.
    if (pageRanges) {
      const offset = rangeStartPage(pageRanges) - 1;
      if (offset > 0) offsetPages(content, offset);
    }

    onProgress(
      `found ${content.equations.length} equations, ${content.statements.length} statements, ${content.figures.length} figures`
    );
    return content;
  }

  private async pollForZip(
    batchId: string,
    fileName: string,
    onProgress: ProgressFn
  ): Promise<string> {
    const deadline = Date.now() + 6 * 60 * 1000;
    let delay = 3000;
    let lastState = "";
    while (Date.now() < deadline) {
      const res = await requestUrl({
        url: `${API}/extract-results/batch/${batchId}`,
        method: "GET",
        headers: this.apiHeaders(),
        throw: false,
      });
      if (res.status === 200 && res.json?.code === 0) {
        const results: any[] = res.json.data?.extract_result ?? [];
        const mine =
          results.find((r) => r.file_name === fileName) ?? results[0];
        const state: string = mine?.state ?? "unknown";
        if (state !== lastState) {
          onProgress(`MinerU: ${state}`);
          lastState = state;
        }
        if (state === "done") {
          if (!mine.full_zip_url) throw new Error("MinerU finished but returned no result URL.");
          return mine.full_zip_url;
        }
        if (state === "failed") {
          throw new Error(`MinerU failed: ${mine.err_msg || "unknown error"}`);
        }
      }
      await sleep(delay);
      delay = Math.min(delay + 1000, 8000);
    }
    throw new Error("MinerU timed out after 6 minutes.");
  }
}

// Case-insensitive so "THEOREM 1" (uppercase) is caught as well as "Theorem 1".
// The single-letter enumerator (e.g. "Assumption A") is guarded so it can't
// swallow a following word like "Corollary to …".
const STATEMENT_RE =
  /^(Theorem|Definition|Lemma|Proposition|Corollary|Assumption|Claim|Condition|Hypothesis|Remark|Example)\s*([0-9]+(?:\.[0-9]+)?|[A-Z](?![A-Za-z]))?\.?/i;

/** Normalize a matched statement keyword to Title case (THEOREM -> Theorem). */
function titleCaseKind(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Config the factory needs to build the selected extractor backend. */
export interface ExtractorConfig {
  backend: "mineru";
  mineruToken: string;
}

/** Build the configured extractor, or null if it isn't set up. */
export function createExtractor(cfg: ExtractorConfig): Extractor | null {
  switch (cfg.backend) {
    case "mineru":
    default: {
      if (!cfg.mineruToken) return null;
      return new MineruExtractor(cfg.mineruToken, {
        enableFormula: true,
        enableTable: true,
        language: "en",
      });
    }
  }
}

/** Parse equations, figures and labeled statements from the MinerU result zip. */
function parseContentFromZip(zip: Uint8Array): ExtractedContent {
  const files = unzipSync(zip);
  const dec = new TextDecoder();
  const equations: ExtractedEquation[] = [];
  const figures: ExtractedFigure[] = [];
  const statements: ExtractedStatement[] = [];
  const blocks: ExtractedBlock[] = [];
  const seenEq = new Set<string>();
  let heading: string | null = null;

  const pushEq = (latex: string, page: number | null) => {
    const clean = cleanLatex(latex);
    if (clean.length >= 2 && !seenEq.has(clean)) {
      seenEq.add(clean);
      equations.push({ latex: clean, page });
    }
  };

  const clKey = Object.keys(files).find((k) => k.endsWith("content_list.json"));
  let arr: any[] | null = null;
  if (clKey) {
    try {
      const parsed = JSON.parse(dec.decode(files[clKey]));
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      /* fall through to markdown */
    }
  }

  if (arr) {
    let lastBlock: ExtractedBlock | null = null;
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      const t = String(b?.type ?? "");
      if (t.includes("equation")) {
        // A display equation is part of the surrounding paragraph — it does NOT
        // break `lastBlock` (so the continuation prose can stitch back on).
        pushEq(b.latex ?? b.text ?? "", numOrNull(b.page_idx));
      } else if (t === "image" || t === "table" || t === "chart") {
        const fig = readFigure(files, b, t);
        if (fig) figures.push(fig);
        lastBlock = null; // a figure breaks the paragraph
      } else if (t === "text") {
        const stmt = readStatement(arr, i);
        if (stmt) statements.push(stmt);
        // Track section headings; build a prose block for each paragraph.
        if (b.text_level != null) {
          heading = String(b.text ?? "").trim() || heading;
          lastBlock = null; // a heading breaks the paragraph
        } else {
          const para = String(b.text ?? "").trim();
          if (isBlockContinuation(lastBlock, para)) {
            // Sentence was split by a display equation — stitch the continuation
            // (and its own trailing equations) back onto the same block.
            lastBlock!.text += `\n\n${para}${trailingEquations(arr, i)}`;
          } else {
            const blk = readBlock(arr, i, heading);
            if (blk) {
              blocks.push(blk);
              lastBlock = blk;
            } else {
              lastBlock = null;
            }
          }
        }
      }
    }
  }

  // Fallback: pull display math ($$...$$) from the markdown if we got none.
  if (equations.length === 0) {
    const mdKey = Object.keys(files).find((k) => k.endsWith(".md"));
    if (mdKey) {
      const md = dec.decode(files[mdKey]);
      const re = /\$\$([\s\S]+?)\$\$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(md)) !== null) pushEq(m[1], null);
    }
  }

  return { equations, figures, statements, blocks };
}

/** A prose paragraph (skipping running heads/footnotes) plus its trailing
 *  display equations, tagged with the nearest section heading. */
function readBlock(
  arr: any[],
  i: number,
  heading: string | null
): ExtractedBlock | null {
  const b = arr[i];
  const para = String(b?.text ?? "").trim();
  // Require a section heading (drops cover/masthead/boilerplate before §1) and
  // skip page numbers / short running heads.
  if (!heading || para.length < 40) return null;
  return {
    heading,
    text: para + trailingEquations(arr, i),
    page: numOrNull(b.page_idx),
  };
}

/** The display equations ($$…$$) immediately following item `i`, up to 4,
 *  as a markdown suffix (empty string if none). */
function trailingEquations(arr: any[], i: number): string {
  let out = "";
  let appended = 0;
  for (let j = i + 1; j < arr.length && appended < 4; j++) {
    if (!String(arr[j]?.type ?? "").includes("equation")) break;
    const eq = cleanLatex(arr[j].latex ?? arr[j].text ?? "");
    if (eq) {
      out += `\n\n$$\n${eq}\n$$`;
      appended++;
    }
  }
  return out;
}

/** Capitalized connectives that, right after a display equation, still continue
 *  the sentence explaining it ("Where P^b is…", "Here x denotes…", "Note that…").
 *  Lowercase forms are already caught by the lowercase-start rule below. */
const CONTINUATION_CONNECTIVE =
  /^(where|which|here|with|such that|so that|for all|in which|that is|given|denotes?|note that|then|thus|hence|therefore|setting|substituting|using|taking|recall|whereas|while)\b/i;

/** True when `para` is a continuation of the previous block that MinerU split —
 *  at a display equation, a column, or a page break — so the two are really one
 *  block. Primary signal: `para` starts lowercase (well-formed paragraphs never
 *  do, so a lowercase "paragraph" is a split-off tail). Right after a display
 *  equation we also accept an inline-math or capitalized-connective start. Stitches
 *  "…the mid-price:  [EQ]  where P^b is…" back into one block. */
function isBlockContinuation(
  last: ExtractedBlock | null,
  para: string
): boolean {
  if (!last || !para) return false;
  // A paragraph beginning lowercase is almost always a split-off continuation.
  if (/^[a-z]/.test(para)) return true;
  // Just after a display equation: "$P^b$ is…" (inline math) or "Where…"/"Here…".
  if (last.text.trimEnd().endsWith("$$")) {
    return /^\$/.test(para) || CONTINUATION_CONNECTIVE.test(para);
  }
  return false;
}

/** A labeled statement text block, plus its trailing display equations. */
function readStatement(arr: any[], i: number): ExtractedStatement | null {
  const b = arr[i];
  const txt = (b?.text ?? "").trim();
  const m = txt.match(STATEMENT_RE);
  if (!m) return null;

  let text = txt;
  let appended = 0;
  for (let j = i + 1; j < arr.length && appended < 4; j++) {
    if (!String(arr[j]?.type ?? "").includes("equation")) break;
    const eq = cleanLatex(arr[j].latex ?? arr[j].text ?? "");
    if (eq) {
      text += `\n\n$$\n${eq}\n$$`;
      appended++;
    }
  }
  return {
    kind: titleCaseKind(m[1]),
    number: m[2] ?? null,
    text,
    page: numOrNull(b.page_idx),
  };
}

/** Read a figure/table/chart block's cropped image bytes + caption. */
function readFigure(
  files: Record<string, Uint8Array>,
  b: any,
  type: string
): ExtractedFigure | null {
  const p: string = b?.img_path ?? "";
  if (!p) return null;
  const key = files[p] ? p : Object.keys(files).find((k) => k.endsWith(p));
  if (!key || !files[key]) return null;

  const capArr = b.image_caption ?? b.table_caption ?? b.chart_caption ?? [];
  const caption = (Array.isArray(capArr) ? capArr.join(" ") : String(capArr || ""))
    .trim();
  const ext =
    (p.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";

  return {
    kind: type === "table" ? "table" : type === "chart" ? "chart" : "figure",
    data: files[key],
    ext,
    caption: caption || null,
    page: numOrNull(b.page_idx),
  };
}

function cleanLatex(s: string): string {
  let t = s.trim();
  // Strip surrounding math delimiters MinerU may include: $$…$$, $…$, \[…\], \(…\).
  t = t.replace(/^\${1,2}/, "").replace(/\${1,2}$/, "");
  t = t.replace(/^\\\[/, "").replace(/\\\]$/, "");
  t = t.replace(/^\\\(/, "").replace(/\\\)$/, "");
  return t.trim();
}

function numOrNull(v: any): number | null {
  return typeof v === "number" ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PUT raw bytes to a presigned URL with no Content-Type header (OSS presigned
 * PUTs reject unexpected headers). Uses Node's http(s) so headers are fully
 * controlled and there's no CORS.
 */
function putBinary(urlStr: string, body: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const doRequest = u.protocol === "http:" ? httpRequest : httpsRequest;
    const req = doRequest(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "PUT",
        headers: { "Content-Length": String(body.length) },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.write(Buffer.from(body));
    req.end();
  });
}
