import { Notice, Plugin, Editor, EditorPosition } from "obsidian";
import {
  ZobSettings,
  DEFAULT_SETTINGS,
  ZobSettingTab,
  STATEMENT_TEMPLATES,
  EQUATION_TEMPLATES,
  FIGURE_TEMPLATES,
} from "./settings";
import {
  ZoteroBridge,
  CurrentReading,
  itemLabel,
  generateCiteKey,
  creatorSummary,
} from "./zotero";
import {
  PaperIndex,
  Suggestion,
  SuggestionRender,
  buildIndexFromText,
  filterSuggestions,
  metadataNoiseWords,
  normalizeMath,
} from "./paper-index";
import { ZobSuggest } from "./suggest";
import { PaperPickerModal } from "./picker";
import { NoteIndex } from "./notes";
import { TFile, normalizePath } from "obsidian";
import { ZoteroItem } from "./zotero";
import {
  createExtractor,
  ExtractedEquation,
  ExtractedFigure,
  ExtractedStatement,
} from "./mineru";
import { createEmbedder, cosine } from "./embedder";
import { BlockImportModal, BlockHit } from "./blocks-modal";
import { RangePromptModal } from "./range-modal";
import { promises as fs } from "fs";

/** Safety-heartbeat cadence while push (long-poll) updates are active. */
const SLOW_HEARTBEAT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** A prose block (paragraph + equations) with its heading and cached vector. */
export interface BlockEntry {
  heading: string | null;
  text: string;
  page: number | null;
  vector?: number[];
}

/** Availability of each optional capability layer (tier). */
export interface Capabilities {
  /** Tier 0: Zotero's local API is reachable. */
  zotero: boolean;
  /** Tier 1: the Zob Bridge is installed (live tab tracking, page, selection). */
  bridge: boolean;
  /** Tier 2: an extractor is configured (MinerU token) for equations/theorems/figures. */
  extractor: boolean;
  /** Tier 3: an embedder is configured (Voyage key or Ollama model) for semantic block import. */
  embedder: boolean;
}

/** Reachability + identity of the configured embedder, for status display. */
export interface EmbedderHealth {
  /** An embedder is set up (key/model present). */
  configured: boolean;
  /** It actually responded (Ollama server up + model present; Voyage key present). */
  reachable: boolean;
  /** Display name: "Ollama" | "Voyage". */
  backend: string;
  /** Model id. */
  model: string;
  /** Short hint shown when not reachable (e.g. "run 'ollama serve'"). */
  note: string;
}

/** Status-bar prefix reflecting how the current paper was resolved (its tier). */
function sourcePrefix(r: CurrentReading): string {
  switch (r.source) {
    case "reader":
      return "Zob ▸ ";
    case "manual":
      return "Zob 📌 ▸ ";
    case "recent":
      return "Zob (recent) ▸ ";
    case "selection":
      return "Zob (selected) ▸ ";
    default:
      return "Zob ▸ ";
  }
}

export default class ZobPlugin extends Plugin {
  settings!: ZobSettings;
  bridge!: ZoteroBridge;

  /** The paper currently open in Zotero's reader (or null). */
  current: CurrentReading | null = null;
  /** Extracted suggestion index for the current paper. */
  currentIndex: PaperIndex | null = null;
  /** Manually-pinned paper (overrides recent auto-tracking when the bridge is absent). */
  pinnedReading: CurrentReading | null = null;

  /** Which capability tiers are currently available (updated each heartbeat). */
  caps: Capabilities = {
    zotero: false,
    bridge: false,
    extractor: false,
    embedder: false,
  };

  /** Cached embedder reachability probe (refreshed lazily, never on the timer). */
  private embedderHealthCache: { at: number; health: EmbedderHealth } | null =
    null;

  /** Papers whose block vectors we've already kicked off a backfill for this
   *  session (so the inline block trigger doesn't re-embed on every keystroke). */
  private blocksEnsured = new Set<string>();

  /** Vault notes indexed by Zotero identifiers (for citation ↔ note linking). */
  noteIndex!: NoteIndex;

  private statusEl!: HTMLElement;
  private pollHandle: number | null = null;
  private lastAttachmentKey: string | null = null;
  private bridgeOk = false;
  private extracting = false;
  /** Debounce handle for auto-extraction around the current reading page. */
  private autoExtractTimer: number | null = null;
  /** Whether the push (long-poll) loop is active. */
  private eventLoopRunning = false;
  /** False once we learn the installed bridge has no /zob/wait endpoint. */
  private pushSupported = true;
  /** Attachment key currentIndex was built for; drives self-healing rebuilds. */
  private indexedKey: string | null = null;
  /** Monotonic token so a slow rebuild can't overwrite a newer paper's index. */
  private indexSeq = 0;

  /** Cached extracted content (equations/statements/figures/blocks) per attachment. */
  private eqCache: Map<
    string,
    {
      mtime: number;
      equations: Suggestion[];
      statements: Suggestion[];
      figures: Suggestion[];
      blocks: BlockEntry[];
      coveredRanges: string[];
      lastUsed: number;
    }
  > = new Map();

  async onload() {
    await this.loadSettings();
    await this.loadEqCache();
    this.bridge = new ZoteroBridge(this.settings.zoteroPort);

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("zob-status");
    this.setStatus("Zob: connecting…");
    this.statusEl.onClickEvent(() => this.tick(true));

    this.addSettingTab(new ZobSettingTab(this.app, this));
    this.registerEditorSuggest(new ZobSuggest(this));

    // Index vault notes by Zotero id; keep it fresh as notes change.
    this.noteIndex = new NoteIndex(this.app, () => ({
      citekeyProp: this.settings.citekeyProperty,
      zoteroKeyProp: this.settings.zoteroKeyProperty,
    }));
    this.app.workspace.onLayoutReady(() => this.noteIndex.rebuild());
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file instanceof TFile) this.noteIndex.indexFile(file);
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => this.noteIndex.rebuild())
    );

    this.addCommand({
      id: "zob-refresh-current",
      name: "Refresh current paper from Zotero",
      callback: () => this.tick(true),
    });

    this.addCommand({
      id: "zob-show-current",
      name: "Show current paper",
      callback: () => {
        const label = this.current?.item ? itemLabel(this.current) : null;
        new Notice(label ? `Zob: ${label}` : "Zob: no paper open in Zotero.");
      },
    });

    this.addCommand({
      id: "zob-extract-equations",
      name: "Extract paper: equations, theorems, figures (MinerU)",
      callback: () => void this.extractPaper(),
    });

    this.addCommand({
      id: "zob-extract-range",
      name: "Extract page range… (merge into this paper)",
      callback: () => {
        const size = Math.max(10, this.settings.autoExtractChunkSize || 100);
        const page = this.current?.page;
        const suggested =
          typeof page === "number" ? chunkFor(page + 1, size) : `1-${size}`;
        new RangePromptModal(this.app, suggested, (range) =>
          void this.extractPaper(range)
        ).open();
      },
    });

    this.addCommand({
      id: "zob-set-current-paper",
      name: "Set current paper…",
      callback: () => this.openPaperPicker(),
    });

    this.addCommand({
      id: "zob-import-block",
      name: "Import block from current paper…",
      editorCallback: (editor) => {
        if (!this.hasBlocks()) {
          new Notice(
            'Zob: no blocks for this paper yet — run "Extract paper" first.'
          );
          return;
        }
        // Backfill vectors in the background (one-time per paper; persists).
        // The modal works (lexically) meanwhile and improves once vectors land.
        const key = this.current?.attachment?.key;
        if (key) {
          const prep = new Notice("Zob: preparing block search…", 0);
          void this.ensureBlockVectors(key, (m) => prep.setMessage(`Zob: ${m}`))
            .finally(() => prep.hide());
        }
        new BlockImportModal(
          this.app,
          editor,
          (q) => this.searchBlocks(q),
          (hit, ed) => this.insertBlock(hit, ed),
          () => this.blockSearchStatus()
        ).open();
      },
    });

    this.addCommand({
      id: "zob-clear-pinned-paper",
      name: "Clear pinned paper (resume auto-tracking)",
      callback: () => {
        this.pinnedReading = null;
        new Notice("Zob: pinned paper cleared.");
        this.refreshCurrent();
      },
    });

    this.addCommand({
      id: "zob-status",
      name: "Show status & capabilities",
      callback: () => void this.showStatus(),
    });

    this.addCommand({
      id: "zob-create-literature-note",
      name: "Create (or open) literature note for current paper",
      callback: () => {
        void (async () => {
          const item = this.current?.item;
          if (!item) {
            new Notice("Zob: no current paper.");
            return;
          }
          const file = await this.createLiteratureNote(item);
          await this.app.workspace.getLeaf(false).openFile(file);
        })();
      },
    });

    this.startPolling();
  }

  onunload() {
    this.stopPolling();
    if (this.autoExtractTimer !== null) window.clearTimeout(this.autoExtractTimer);
  }

  // ---- update loop (tiered) ---------------------------------------------
  //
  // Tier 1 (bridge present): runEventLoop() blocks on /zob/wait and applies
  //   the active reader tab the instant it changes (live push).
  // Tier 0 (no bridge): the heartbeat tick() resolves the current paper from
  //   a manually-pinned item, else the most recently modified paper via the
  //   Zotero local API. Nothing hard-fails when the bridge is absent.
  // The heartbeat always runs as the safety net and detects the bridge coming
  // and going.

  startPolling() {
    void this.tick(true);
    this.setHeartbeat(SLOW_HEARTBEAT_MS);
  }

  stopPolling() {
    this.eventLoopRunning = false;
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.pushSupported = true;
    this.startPolling();
  }

  /** Re-resolve the current paper now (used by commands and settings). */
  refreshCurrent() {
    void this.tick(false);
  }

  /** Rebuild the note index (after the frontmatter-key settings change). */
  rebuildNoteIndex() {
    this.noteIndex?.rebuild();
  }

  /**
   * Create a literature note for an item (or return the existing one, matched
   * by Zotero key / citekey). Standalone — no ZotLit required.
   */
  async createLiteratureNote(item: ZoteroItem): Promise<TFile> {
    const citekey = item.citationKey || generateCiteKey(item);
    const existing = this.noteIndex?.lookup(item.key, citekey);
    if (existing) return existing;

    const fields = noteFields(item, citekey);
    const folder = this.settings.literatureFolder.trim();
    const name =
      sanitizeFilename(fillTemplate(this.settings.noteFilenameTemplate, fields)) ||
      citekey;
    const dir = folder ? normalizePath(folder) : "";
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }

    let path = normalizePath(dir ? `${dir}/${name}.md` : `${name}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(dir ? `${dir}/${name} ${n}.md` : `${name} ${n}.md`);
      n++;
    }

    const body = fillTemplate(this.settings.noteTemplate, fields);
    const file = await this.app.vault.create(path, body);
    this.noteIndex?.indexFile(file);
    return file;
  }

  /** Fetch full item metadata by key, then create (or find) its note. */
  async createLiteratureNoteByKey(itemKey: string): Promise<TFile | null> {
    const reading = await this.bridge.readingForItem(
      itemKey,
      this.settings.zoteroDataDir
    );
    if (!reading?.item) return null;
    return this.createLiteratureNote(reading.item);
  }

  /** Create the note for an item, then replace the trigger with a wikilink. */
  async createNoteAndLink(
    itemKey: string,
    citekey: string,
    editor: Editor,
    start: EditorPosition,
    end: EditorPosition
  ): Promise<void> {
    try {
      const file = await this.createLiteratureNoteByKey(itemKey);
      if (!file) {
        new Notice("Zob: couldn't load that item from Zotero.");
        return;
      }
      const key = citekey || file.basename.replace(/^@/, "");
      editor.replaceRange(wikilink(file, key), start, end);
      new Notice(`Zob: created ${file.basename}`);
    } catch (e: any) {
      new Notice(`Zob: couldn't create note — ${e?.message ?? e}`);
      console.error("[Zob] create note failed", e);
    }
  }

  /** Open the library picker to manually pin the current paper. */
  openPaperPicker() {
    new PaperPickerModal(
      this.app,
      (q) => this.bridge.searchLibrary(q, 20),
      (hit) => {
        void (async () => {
          const reading = await this.bridge.readingForItem(
            hit.key,
            this.settings.zoteroDataDir
          );
          if (!reading) {
            new Notice("Zob: couldn't load that item from Zotero.");
            return;
          }
          this.pinnedReading = reading;
          this.applyReading(reading, true);
        })();
      }
    ).open();
  }

  private setHeartbeat(ms: number) {
    if (this.pollHandle !== null) window.clearInterval(this.pollHandle);
    this.pollHandle = window.setInterval(() => void this.tick(false), ms);
    this.registerInterval(this.pollHandle);
  }

  /** Push loop: block until Zotero's active tab changes, then apply it. */
  private async runEventLoop() {
    while (this.eventLoopRunning) {
      const res = await this.bridge.waitForChange();
      if (!this.eventLoopRunning) break;
      if (!res.ok) {
        // Bridge went away or is too old for push — stop the loop; the
        // heartbeat tick() takes over (and restarts push if it returns).
        if (res.unsupported) this.pushSupported = false;
        this.eventLoopRunning = false;
        break;
      }
      this.bridgeOk = true;
      this.applyReading(res.reading, false);
    }
  }

  /** Heartbeat: resolve the current paper via the best available tier. */
  private async tick(verbose: boolean) {
    this.caps.extractor =
      this.settings.enableEquations && !!this.settings.mineruToken;
    // Config-only check (no network) — reachability is probed lazily in
    // embedderHealth() when the status is actually shown.
    this.caps.embedder = !!this.embedder();

    const bridgeOk = await this.bridge.ping();
    this.bridgeOk = bridgeOk;
    this.caps.bridge = bridgeOk;

    if (bridgeOk) {
      this.caps.zotero = true;
      // Tier 1: live. (Re)start the push loop if it isn't running.
      if (this.pushSupported && !this.eventLoopRunning) {
        this.eventLoopRunning = true;
        void this.runEventLoop();
      }
      this.applyReading(await this.bridge.current(), verbose);
      return;
    }

    // No bridge — fall back to Tier 0.
    this.eventLoopRunning = false;
    await this.resolveTier0(verbose);
  }

  /** Tier 0 current-paper resolution: pinned item, else most-recent paper. */
  private async resolveTier0(verbose: boolean) {
    if (this.pinnedReading) {
      this.applyReading(this.pinnedReading, verbose);
      return;
    }
    const alive = await this.bridge.zoteroAlive();
    this.caps.zotero = alive;
    if (!alive) {
      this.setStatus("Zob: Zotero not reachable");
      if (verbose) {
        new Notice("Zob: can't reach Zotero. Is Zotero running?");
      }
      return;
    }
    if (this.settings.autoTrackRecent) {
      const reading = await this.bridge.recentReading(
        this.settings.zoteroDataDir
      );
      this.applyReading(reading, verbose);
    } else {
      this.current = null;
      this.setStatus('Zob: run "Set current paper" to pick a paper');
    }
  }

  /** Shared handling of a reading, whether pushed or polled. */
  private applyReading(reading: CurrentReading | null, verbose: boolean) {
    this.current = reading;

    const key = reading?.attachment?.key ?? null;
    const changed = key !== this.lastAttachmentKey;
    this.lastAttachmentKey = key;

    if (reading?.item) {
      this.setStatus(sourcePrefix(reading) + itemLabel(reading));
    } else {
      this.setStatus("Zob: no paper open");
    }

    if (changed && verbose && reading?.item) {
      new Notice(`Zob now tracking: ${itemLabel(reading)}`);
    }

    // Rebuild whenever the index doesn't match the open paper. Self-healing:
    // if a rebuild is ever missed, the next tick retries it.
    if (key !== this.indexedKey) {
      void this.rebuildIndex(reading);
    }

    this.maybeAutoExtract(reading);
  }

  /**
   * Auto-mode: when enabled, extract the page-chunk around where you're reading,
   * and — as you read into a new, uncovered chunk — extract + merge that one too.
   * Needs the live bridge page and a configured extractor. Debounced so flipping
   * through pages doesn't fire off extractions.
   */
  private maybeAutoExtract(reading: CurrentReading | null) {
    if (!this.settings.autoExtract || !this.caps.extractor || this.extracting) {
      return;
    }
    const att = reading?.attachment;
    const page0 = reading?.page;
    if (
      !att?.path ||
      att.contentType !== "application/pdf" ||
      typeof page0 !== "number"
    ) {
      return;
    }
    const size = Math.max(10, this.settings.autoExtractChunkSize || 100);
    const covered = this.eqCache.get(att.key)?.coveredRanges ?? [];
    if (pageInRanges(page0 + 1, covered)) return;

    if (this.autoExtractTimer !== null) window.clearTimeout(this.autoExtractTimer);
    this.autoExtractTimer = window.setTimeout(() => {
      this.autoExtractTimer = null;
      // Re-check once the page has settled (it may have moved or been covered).
      const cur = this.current;
      if (
        !this.settings.autoExtract ||
        this.extracting ||
        cur?.attachment?.key !== att.key ||
        typeof cur?.page !== "number"
      ) {
        return;
      }
      const cov = this.eqCache.get(att.key)?.coveredRanges ?? [];
      if (pageInRanges(cur.page + 1, cov)) return;
      void this.extractPaper(chunkFor(cur.page + 1, size));
    }, 4000);
  }

  // ---- index building ----------------------------------------------------

  private async rebuildIndex(reading: CurrentReading | null) {
    const att = reading?.attachment;
    const seq = ++this.indexSeq;

    if (!att || att.contentType !== "application/pdf") {
      this.currentIndex = null;
      this.indexedKey = att?.key ?? null;
      return;
    }

    try {
      const text = await this.bridge.fulltext(att.key);
      if (seq !== this.indexSeq) return; // a newer switch superseded this one
      if (!text) {
        this.currentIndex = null;
        this.indexedKey = att.key;
        return;
      }

      const noise = metadataNoiseWords(
        reading?.item?.creators ?? [],
        reading?.item?.publicationTitle
      );
      const index = buildIndexFromText(
        att.key,
        reading?.item?.title ?? "",
        text,
        noise
      );

      // Attach previously extracted equations if the PDF is unchanged.
      const cached = this.eqCache.get(att.key);
      if (cached) {
        const mtime = await this.fileMtime(att.path);
        if (seq !== this.indexSeq) return;
        if (mtime === null || Math.abs(mtime - cached.mtime) < 1000) {
          cached.lastUsed = Date.now(); // touch for LRU
          index.equations = cached.equations;
        }
      }

      if (seq !== this.indexSeq) return; // abandon a stale (old-paper) result
      this.currentIndex = index;
      this.indexedKey = att.key;

      const n = index.terms.length + index.refs.length + index.equations.length;
      this.setStatus(`Zob ▸ ${itemLabel(reading)}  (${n} suggestions)`);
    } catch (e) {
      console.error("[Zob] indexing failed", e);
      // Leave indexedKey unchanged so the next poll retries this paper.
    }
  }

  // ---- suggestion providers ---------------------------------------------

  /** Paper-context suggestions (terms / figures / equations), synchronous. */
  getPaperSuggestions(query: string): Suggestion[] {
    const attKey = this.current?.attachment?.key ?? null;

    // Only trust the text index if it was built for the paper open *now*.
    // Otherwise its terms/figures are stale and must not be shown.
    const index =
      this.currentIndex && this.currentIndex.attachmentKey === attKey
        ? this.currentIndex
        : null;

    // Equations always come live from the cache, keyed by the currently-open
    // attachment — so a slow or stale index can never surface a previous
    // paper's equations.
    // Equations / statements / figures come live from the cache, keyed by the
    // currently-open attachment — never a previous paper's.
    const cached = attKey ? this.eqCache.get(attKey) : undefined;
    const cachedPool = cached
      ? [...cached.equations, ...cached.statements, ...cached.figures]
      : [];

    const combined: PaperIndex = {
      attachmentKey: attKey ?? "",
      title: index?.title ?? "",
      terms: [], // frequency-based terms removed — noisy next to real content
      refs: index?.refs ?? [],
      equations: cachedPool,
    };
    const results = filterSuggestions(combined, query, 40);

    // Offer a one-time "extract" row when nothing is cached for this paper yet.
    const canExtract =
      this.settings.enableEquations &&
      !!this.settings.mineruToken &&
      !!this.current?.attachment?.path &&
      cachedPool.length === 0;
    const q = query.toLowerCase().trim();
    const wantsIt =
      q === "" || "equations".startsWith(q) || "extract".startsWith(q);
    if (canExtract && wantsIt && !this.extracting) {
      results.unshift({
        kind: "equation",
        label: "⚙ Extract this paper — equations, theorems, figures (MinerU)",
        detail: "one-time · uploads the PDF · ~1 min",
        insert: "",
        score: 1e9,
        action: "extract-equations",
      });
    }
    return results;
  }

  /** Text to insert for a suggestion, optionally with a zotero:// page backlink. */
  insertTextFor(s: Suggestion): string {
    const text = s.render
      ? renderInsert(s.render, this.settings, s.page)
      : s.insert;
    if (
      !this.settings.insertBacklinks ||
      s.action ||
      s.kind === "citation" ||
      typeof s.page !== "number"
    ) {
      return text;
    }
    const key = this.current?.attachment?.key;
    if (!key) return text;
    const p = s.page + 1; // zotero ?page= is 1-based
    const link = `[📄 p.${p}](zotero://open-pdf/library/items/${key}?page=${p})`;
    return `${text.replace(/\s+$/, "")}\n${link}\n`;
  }

  /** Citation suggestions from the Zotero library, async. */
  async getCitationSuggestions(query: string): Promise<Suggestion[]> {
    const q = query.trim();
    const out: Suggestion[] = [];

    // With no query yet, offer the paper you're currently reading.
    if (q.length < 2) {
      const it = this.current?.item;
      if (it) {
        out.push(
          this.citationSuggestion(it.citationKey, it.key, it.title, "(current paper)", 1e6, it)
        );
        if (!this.noteIndex?.lookup(it.key, it.citationKey)) {
          out.push(this.createNoteSuggestion(it.citationKey, it.key, it, 1e6));
        }
      }
      return out;
    }

    const hits = await this.bridge.searchLibrary(q, 20);
    for (const h of hits) {
      out.push(
        this.citationSuggestion(h.citationKey, h.key, h.title, creatorSummary(h), 0, h)
      );
      if (!this.noteIndex?.lookup(h.key, h.citationKey)) {
        out.push(this.createNoteSuggestion(h.citationKey, h.key, h, 0));
      }
    }
    return out;
  }

  /**
   * Build a citation suggestion in one of two modes:
   *  - a matching literature note exists → insert a bidirectional [[wikilink]]
   *  - no note → insert [@citekey](zotero://select/...) linking to Zotero.
   */
  private citationSuggestion(
    citationKey: string | null,
    itemKey: string,
    title: string | null,
    meta: string,
    score: number,
    forKeygen: { creators?: any[]; date?: string | null; title?: string | null }
  ): Suggestion {
    const key = citationKey || generateCiteKey(forKeygen);
    const note = this.noteIndex?.lookup(itemKey, citationKey);
    if (note) {
      return {
        kind: "citation",
        label: `@${key}`,
        detail: `→ ${note.basename}  ·  ${meta}`.trim(),
        insert: wikilink(note, key),
        score: score + 10, // prefer papers you already have notes for
      };
    }
    const link = itemKey
      ? `[@${key}](zotero://select/library/items/${itemKey})`
      : `[@${key}]`;
    return {
      kind: "citation",
      label: `@${key}`,
      detail: `↗ Zotero  ·  ${title ?? ""} — ${meta}`.trim(),
      insert: link,
      score,
    };
  }

  /** A "create & link literature note" row, offered when no note exists yet. */
  private createNoteSuggestion(
    citationKey: string | null,
    itemKey: string,
    forKeygen: { creators?: any[]; date?: string | null; title?: string | null },
    score: number
  ): Suggestion {
    const key = citationKey || generateCiteKey(forKeygen);
    return {
      kind: "citation",
      label: `＋ create & link note — @${key}`,
      detail: "makes a literature note, then inserts a wikilink",
      insert: "",
      score: score - 1,
      action: "create-note",
      citeItemKey: itemKey,
      citeKey: key,
    };
  }

  // ---- semantic block search --------------------------------------------

  /** Whether the current paper has importable blocks cached. */
  hasBlocks(): boolean {
    const key = this.current?.attachment?.key;
    return !!key && (this.eqCache.get(key)?.blocks.length ?? 0) > 0;
  }

  /** Build the configured embedder from settings (or null). */
  private embedder() {
    return createEmbedder({
      backend: this.settings.embedderBackend,
      voyageApiKey: this.settings.voyageApiKey,
      voyageModel: this.settings.embedModel,
      ollamaUrl: this.settings.ollamaUrl,
      ollamaModel: this.settings.ollamaModel,
    });
  }

  /** Reachability + identity of the configured embedder. Cached ~60s so it's
   *  cheap to call from the status command / block modal; never on the timer. */
  async embedderHealth(force = false): Promise<EmbedderHealth> {
    const now = Date.now();
    if (
      !force &&
      this.embedderHealthCache &&
      now - this.embedderHealthCache.at < 60_000
    ) {
      return this.embedderHealthCache.health;
    }
    const ollama = this.settings.embedderBackend === "ollama";
    const backend = ollama ? "Ollama" : "Voyage";
    const model = ollama
      ? this.settings.ollamaModel
      : this.settings.embedModel || "voyage-3.5-lite";
    const embedder = this.embedder();
    let health: EmbedderHealth;
    if (!embedder) {
      health = {
        configured: false,
        reachable: false,
        backend,
        model,
        note: ollama ? "run Ollama + pull a model" : "set a Voyage API key",
      };
    } else {
      const p = await embedder.probe();
      health = { configured: true, reachable: p.ok, backend, model, note: p.note };
    }
    this.embedderHealthCache = { at: now, health };
    return health;
  }

  /** Invalidate the cached probe (e.g. after a settings change). */
  resetEmbedderHealth() {
    this.embedderHealthCache = null;
  }

  /** One-line status for the block-import modal: are we ranking semantically
   *  (embedder reachable + this paper's blocks embedded) or lexically, and why. */
  async blockSearchStatus(): Promise<{ label: string; detail: string }> {
    const key = this.current?.attachment?.key;
    const entry = key ? this.eqCache.get(key) : undefined;
    const total = entry?.blocks.length ?? 0;
    const embedded = entry?.blocks.filter((b) => b.vector).length ?? 0;
    const h = await this.embedderHealth();
    if (h.reachable && embedded > 0) {
      return {
        label: "Semantic",
        detail: `${h.backend}${h.model ? ` (${h.model})` : ""} · ${embedded}/${total} blocks`,
      };
    }
    // Lexical right now — say why (so a silent fallback becomes visible).
    const why = !h.configured
      ? "no embedder → set a Voyage key or run Ollama"
      : !h.reachable
        ? `${h.backend} unreachable → ${h.note}`
        : `embedding ${embedded}/${total} blocks…`;
    return { label: "Lexical", detail: why };
  }

  /** Embed the given blocks in place (attaches `.vector`), chunked by the
   *  embedder. Returns false if no embedder is configured or the count didn't
   *  match. Does not persist — the caller owns saving. */
  private async embedBlocks(
    blocks: BlockEntry[],
    onProgress?: (msg: string) => void
  ): Promise<boolean> {
    if (blocks.length === 0) return true;
    const embedder = this.embedder();
    if (!embedder) return false;
    onProgress?.(`embedding ${blocks.length} blocks (${embedder.name})…`);
    const texts = blocks.map((b) => (b.heading ? b.heading + ". " : "") + b.text);
    const vecs = await embedder.embed(texts, "document");
    if (vecs.length !== blocks.length) return false;
    blocks.forEach((b, i) => (b.vector = vecs[i]));
    return true;
  }

  /** Backfill a paper's block vectors (missing ones, or all on a model change),
   *  persisting the result. Used when the Import-block modal opens. */
  async ensureBlockVectors(
    key: string,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const entry = this.eqCache.get(key);
    if (!entry || entry.blocks.length === 0) return;
    const embedder = this.embedder();
    if (!embedder) return; // no embedder — searchBlocks falls back to lexical

    let need = entry.blocks.filter((b) => !b.vector);
    // If existing vectors came from a different model (dim mismatch), re-embed all.
    const existing = entry.blocks.find((b) => b.vector);
    if (existing?.vector) {
      try {
        const [probe] = await embedder.embed(["probe"], "query");
        if (probe && probe.length !== existing.vector.length) {
          entry.blocks.forEach((b) => (b.vector = undefined));
          need = entry.blocks;
        }
      } catch {
        return; // embedder unreachable — lexical fallback
      }
    }
    if (need.length === 0) return;
    try {
      if (await this.embedBlocks(need, onProgress)) await this.saveEqCache();
    } catch (e) {
      console.error("[Zob] ensureBlockVectors failed", e);
    }
  }

  /**
   * Rank the current paper's cached blocks against a query. Semantic (embedding)
   * ranking when vectors are present, always with a lexical bump; pure lexical
   * fallback when the embedder is unavailable. Never drops blocks merely for
   * lacking a vector, and uses a relative cutoff so late-page hits still show.
   * Embedding is NOT done here (see extractPaper / ensureBlockVectors).
   */
  async searchBlocks(query: string): Promise<BlockHit[]> {
    const key = this.current?.attachment?.key;
    if (!key) return [];
    const entry = this.eqCache.get(key);
    if (!entry || entry.blocks.length === 0) return [];
    const blocks = entry.blocks;
    const q = query.trim().toLowerCase();
    const toHit = (b: BlockEntry): BlockHit => ({
      heading: b.heading,
      text: b.text,
      page: b.page,
    });

    let queryVec: number[] | null = null;
    const embedder = this.embedder();
    if (embedder && blocks.some((b) => b.vector) && q.length >= 2) {
      try {
        const [qv] = await embedder.embed([query], "query");
        queryVec = qv ?? null;
      } catch (e) {
        console.error("[Zob] query embed failed; lexical only", e);
      }
    }

    const scored = blocks.map((b) => {
      const sem =
        queryVec && b.vector && b.vector.length === queryVec.length
          ? cosine(queryVec, b.vector)
          : 0;
      let lex = 0;
      if (q) {
        const heading = (b.heading ?? "").toLowerCase();
        if (heading.includes(q)) lex = 0.5;
        else if (b.text.toLowerCase().includes(q)) lex = 0.3;
      }
      // Semantic drives when available; lexical is a bump (or the whole score
      // when there's no query vector).
      return { b, score: queryVec ? sem + lex * 0.3 : lex };
    });

    scored.sort((a, b) => b.score - a.score);
    if (!q) return scored.slice(0, 25).map((x) => toHit(x.b));

    // Relative cutoff: keep everything within 60% of the best score, so a
    // slightly-lower late-page block isn't excluded by an absolute threshold.
    // No positive score at all → honest "no match" (don't show arbitrary blocks).
    const top = scored[0]?.score ?? 0;
    if (top <= 0) return [];
    return scored
      .filter((x) => x.score >= Math.max(top * 0.6, 0.01))
      .slice(0, 25)
      .map((x) => toHit(x.b));
  }

  /** Insert a block's markdown (paragraph + equations) into the active note. */
  insertBlock(hit: BlockHit, editor: Editor) {
    let text = hit.text.replace(/\n*$/, "") + "\n";
    if (this.settings.insertBacklinks && typeof hit.page === "number") {
      const key = this.current?.attachment?.key;
      if (key) {
        const p = hit.page + 1;
        text += `[📄 p.${p}](zotero://open-pdf/library/items/${key}?page=${p})\n`;
      }
    }
    editor.replaceSelection(text);
  }

  /** Inline block autocomplete (the "::" trigger): semantic block search mapped
   *  onto Suggestions so it flows through the shared EditorSuggest insert path
   *  (insertTextFor adds the page backlink, same as insertBlock). */
  async getBlockSuggestions(query: string): Promise<Suggestion[]> {
    const key = this.current?.attachment?.key;
    if (!key || !this.hasBlocks()) return [];
    // Backfill this paper's block vectors once (semantic ranking kicks in once
    // they land; searchBlocks ranks lexically meanwhile).
    if (!this.blocksEnsured.has(key)) {
      this.blocksEnsured.add(key);
      void this.ensureBlockVectors(key);
    }
    const hits = await this.searchBlocks(query);
    return hits.map((h) => this.blockToSuggestion(h));
  }

  private blockToSuggestion(h: BlockHit): Suggestion {
    const preview = h.text
      .replace(/\$\$[\s\S]*?\$\$/g, " [eq] ")
      .replace(/\s+/g, " ")
      .trim();
    const label = preview.length > 120 ? preview.slice(0, 119) + "…" : preview;
    const detail = [h.heading, typeof h.page === "number" ? `p.${h.page + 1}` : null]
      .filter(Boolean)
      .join("  ·  ");
    return {
      kind: "block",
      label,
      detail: detail || undefined,
      insert: h.text,
      page: typeof h.page === "number" ? h.page : undefined,
      score: 0,
    };
  }

  // ---- paper extraction (pluggable backend) -----------------------------

  /**
   * Extract a paper. With `pageRange` (e.g. "101-200") only those pages are sent
   * to MinerU and the result is MERGED into the paper's cache (dedup + covered
   * ranges tracked). Without a range, the whole PDF is extracted (replace).
   */
  async extractPaper(pageRange?: string): Promise<void> {
    const att = this.current?.attachment;
    if (!att?.path || att.contentType !== "application/pdf") {
      new Notice("Zob: no PDF open in Zotero to extract from.");
      return;
    }
    const extractor = createExtractor({
      backend: this.settings.extractorBackend,
      mineruToken: this.settings.mineruToken,
    });
    if (!extractor) {
      new Notice("Zob: no extractor configured. Set a MinerU token in settings.");
      return;
    }
    if (this.extracting) {
      new Notice("Zob: an extraction is already running.");
      return;
    }

    this.extracting = true;
    const what = pageRange ? `pages ${pageRange}` : "paper";
    const notice = new Notice(`Zob: extracting ${what} (${extractor.name})…`, 0);
    try {
      const content = await extractor.extract(
        att.path,
        (m) => notice.setMessage(`Zob: ${m}`),
        pageRange
      );

      const newEq = content.equations.map((e, i) => equationSuggestion(e, i));
      const newSt = content.statements.map((s, i) => statementSuggestion(s, i));
      const newFig = await this.saveFigures(att.key, content.figures);
      const newBl: BlockEntry[] = content.blocks.map((b) => ({
        heading: b.heading,
        text: b.text,
        page: b.page,
      }));
      // Embed just this range's blocks now (bounded, reliable) so search never
      // has to embed the whole paper at once. Non-fatal if the embedder is down.
      try {
        await this.embedBlocks(newBl, (m) => notice.setMessage(`Zob: ${m}`));
      } catch (e) {
        console.error("[Zob] block embedding failed (will fall back to lexical)", e);
      }

      const mtime = (await this.fileMtime(att.path)) ?? Date.now();
      const prev = this.eqCache.get(att.key);
      const entry =
        pageRange && prev
          ? {
              mtime,
              equations: mergeSuggestions(prev.equations, newEq, eqKey, 900),
              statements: mergeSuggestions(prev.statements, newSt, stKey, 950),
              figures: mergeSuggestions(prev.figures, newFig, figKey, 700),
              blocks: mergeBlocks(prev.blocks, newBl),
              coveredRanges: addRange(prev.coveredRanges, pageRange),
              lastUsed: Date.now(),
            }
          : {
              mtime,
              equations: newEq,
              statements: newSt,
              figures: newFig,
              blocks: newBl,
              // A whole-PDF extraction covers everything (sentinel) so auto-mode
              // never re-extracts it; a first ranged extraction covers its range.
              coveredRanges: pageRange ? [pageRange] : ["1-99999"],
              lastUsed: Date.now(),
            };
      this.eqCache.set(att.key, entry);
      this.enforceCacheLimit(att.key);
      await this.saveEqCache();

      const cov = entry.coveredRanges.length
        ? ` · pages ${entry.coveredRanges.join(", ")}`
        : "";
      notice.setMessage(
        `Zob: ${entry.equations.length} equations, ${entry.statements.length} statements, ${entry.figures.length} figures, ${entry.blocks.length} blocks${cov}.`
      );
      window.setTimeout(() => notice.hide(), 6000);
    } catch (e: any) {
      notice.hide();
      new Notice(`Zob: extraction failed — ${e?.message ?? e}`, 8000);
      console.error("[Zob] MinerU extraction failed", e);
    } finally {
      this.extracting = false;
    }
  }

  /** Save figure crops into the vault and build insertable suggestions. */
  private async saveFigures(
    attachmentKey: string,
    figures: ExtractedFigure[]
  ): Promise<Suggestion[]> {
    if (figures.length === 0) return [];
    const adapter = this.app.vault.adapter;
    const dir = `zob-figures/${attachmentKey}`;
    try {
      if (!(await adapter.exists("zob-figures"))) await adapter.mkdir("zob-figures");
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    } catch (e) {
      console.error("[Zob] could not create figure folder", e);
    }

    const out: Suggestion[] = [];
    for (let i = 0; i < figures.length; i++) {
      const fig = figures[i];
      const path = `${dir}/${fig.kind}-p${(fig.page ?? 0) + 1}-${i + 1}.${fig.ext}`;
      try {
        await adapter.writeBinary(path, toArrayBuffer(fig.data));
        out.push(figureSuggestion(path, fig, i));
      } catch (e) {
        console.error("[Zob] failed to save figure", path, e);
      }
    }
    return out;
  }

  private async fileMtime(path: string | null): Promise<number | null> {
    if (!path) return null;
    try {
      return (await fs.stat(path)).mtimeMs;
    } catch {
      return null;
    }
  }

  private cachePath(): string {
    return `${this.app.vault.configDir}/plugins/zob/equation-cache.json`;
  }

  private async loadEqCache(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.cachePath());
      const obj = JSON.parse(raw) as Record<
        string,
        {
          mtime: number;
          equations?: Suggestion[];
          statements?: Suggestion[];
          figures?: Suggestion[];
          blocks?: BlockEntry[];
          coveredRanges?: string[];
          lastUsed?: number;
        }
      >;
      this.eqCache = new Map(
        Object.entries(obj).map(([k, v]) => [
          k,
          {
            mtime: v.mtime,
            equations: (v.equations ?? []).map(normalizeEqSuggestion),
            statements: (v.statements ?? []).map(backfillPage).map(backfillRender),
            figures: (v.figures ?? []).map(backfillPage).map(backfillRender),
            blocks: v.blocks ?? [],
            coveredRanges: v.coveredRanges ?? [],
            lastUsed: v.lastUsed ?? 0,
          },
        ])
      );
      // Apply the limit on load in case it was lowered or the file predates it.
      if (this.enforceCacheLimit()) await this.saveEqCache();
    } catch {
      this.eqCache = new Map();
    }
  }

  async saveEqCache(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.eqCache);
      await this.app.vault.adapter.write(
        this.cachePath(),
        JSON.stringify(obj)
      );
    } catch (e) {
      console.error("[Zob] failed to persist equation cache", e);
    }
  }

  /**
   * Evict least-recently-used cached papers until the cache is under the
   * configured size limit. `keepKey` (the paper just cached) is never evicted.
   * Returns true if anything was removed.
   */
  enforceCacheLimit(keepKey?: string): boolean {
    const maxBytes = Math.max(1, this.settings.cacheMaxMB) * 1024 * 1024;

    const sizes = new Map<string, number>();
    let total = 0;
    for (const [k, v] of this.eqCache) {
      const bytes = JSON.stringify(v).length;
      sizes.set(k, bytes);
      total += bytes;
    }
    if (total <= maxBytes) return false;

    const lru = Array.from(this.eqCache.keys())
      .filter((k) => k !== keepKey)
      .sort(
        (a, b) =>
          (this.eqCache.get(a)?.lastUsed ?? 0) -
          (this.eqCache.get(b)?.lastUsed ?? 0)
      );

    let evicted = 0;
    for (const k of lru) {
      if (total <= maxBytes) break;
      total -= sizes.get(k) ?? 0;
      this.eqCache.delete(k);
      evicted++;
    }
    return evicted > 0;
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
    // Tooltip shows which capability tiers are active.
    this.statusEl.setAttr("aria-label", `${text}\n${this.capabilitySummary()}`);
  }

  /** Human-readable summary of active/missing capability tiers. */
  capabilitySummary(): string {
    const mark = (on: boolean) => (on ? "✓" : "○");
    return [
      `${mark(this.caps.zotero)} Zotero (base)`,
      `${mark(this.caps.bridge)} Bridge (live tab/page/selection)`,
      `${mark(this.caps.extractor)} Extractor (equations/theorems/figures)`,
      `${mark(this.caps.embedder)} Semantic (block import by meaning)`,
    ].join("   ");
  }

  /** Notice with the current paper, active tiers, and how to enable missing ones. */
  private async showStatus() {
    const lines: string[] = [];
    lines.push(
      this.current?.item
        ? `Paper: ${itemLabel(this.current)}  (${this.current.source ?? "?"})`
        : "Paper: none"
    );
    lines.push("");
    lines.push(
      `${this.caps.zotero ? "✓" : "○"} Base — Zotero local API` +
        (this.caps.zotero ? "" : "  → start Zotero")
    );
    lines.push(
      `${this.caps.bridge ? "✓" : "○"} Live — Zob Bridge` +
        (this.caps.bridge ? "" : "  → install the bridge xpi for live tab/page/selection")
    );
    lines.push(
      `${this.caps.extractor ? "✓" : "○"} Content — extractor` +
        (this.caps.extractor ? "" : "  → set a MinerU token in settings")
    );
    // Reachability-probed (not just configured), so ✓ means it actually works.
    const h = await this.embedderHealth();
    lines.push(
      `${h.reachable ? "✓" : "○"} Semantic — ${h.backend}` +
        (h.reachable ? ` (${h.model})` : `  → ${h.note}`)
    );
    new Notice(lines.join("\n"), 10000);
  }

  // ---- settings ----------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Migrate the previous default without changing deliberately customized
    // triggers. New installs use "::" from DEFAULT_SETTINGS.
    if (this.settings.blockTrigger === ";;;") this.settings.blockTrigger = "::";
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Config may have changed the embedder — re-probe on next status read.
    this.resetEmbedderHealth();
  }
}

/** A readable one-line label from LaTeX: structural noise stripped so it reads
 *  like the math ("X_{t} = X_0 + …"), not "\begin{array}…". The full LaTeX is
 *  still what gets inserted — this only affects the browsing label. */
function prettyLatex(latex: string): string {
  let s = latex
    .replace(/\\tag\{[^}]*\}/g, "")
    .replace(/\\begin\{[^}]*\}(\s*\{[^}]*\})?/g, "") // \begin{array}{l} incl. col-spec
    .replace(/\\end\{[^}]*\}/g, "")
    .replace(/\\displaystyle/g, "")
    .replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\[,;:!]/g, " ")
    .replace(/\\q?quad/g, " ")
    .replace(/\s*_\s*/g, "_")
    .replace(/\s*\^\s*/g, "^");
  // Unwrap grouping braces repeatedly: {t} -> t, {{X_t}} -> X_t.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{\s*([^{}]*?)\s*\}/g, "$1");
  } while (s !== prev);
  return s.replace(/\s+/g, " ").trim();
}

/** Build an equation suggestion. `insert` keeps the FULL original LaTeX so the
 *  equation is pasted verbatim; label/searchKey are derived for browsing. */
function buildEquationSuggestion(
  latex: string,
  page: number | null,
  score: number
): Suggestion {
  const tag = latex.match(/\\tag\{([^}]*)\}/)?.[1] ?? null;
  const shown = ((tag ? `(${tag}) ` : "") + prettyLatex(latex)).trim();
  const label = shown.length > 72 ? shown.slice(0, 71) + "…" : shown || "(equation)";
  const pageLabel = page !== null ? `p.${page + 1}` : null;
  const render: SuggestionRender = { type: "equation", latex, tag: tag ?? "" };
  return {
    kind: "equation",
    label,
    detail: [tag ? `eq (${tag})` : "equation", pageLabel]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, page ?? undefined), // block form = full LaTeX verbatim
    render,
    score,
    eqNum: tag ?? undefined,
    searchKey: normalizeMath(latex),
    page: page ?? undefined,
  };
}

function equationSuggestion(e: ExtractedEquation, index: number): Suggestion {
  return buildEquationSuggestion(e.latex, e.page, 900 - index);
}

/** Re-derive label/number/searchKey for a cached equation (written before
 *  these existed) from its stored insert, preserving the exact insert text. */
function normalizeEqSuggestion(s: Suggestion): Suggestion {
  if (s.kind !== "equation" || s.action) return s;
  const latex = s.insert.replace(/\$\$/g, "").trim();
  const pageM = s.detail?.match(/p\.(\d+)/);
  const pageIdx = pageM ? parseInt(pageM[1], 10) - 1 : null;
  const rebuilt = buildEquationSuggestion(latex, pageIdx, s.score);
  rebuilt.insert = s.insert; // keep the original paste text exactly
  return rebuilt;
}

const STATEMENT_ALIASES: Record<string, string> = {
  theorem: "theorem thm",
  definition: "definition def",
  lemma: "lemma",
  proposition: "proposition prop",
  corollary: "corollary cor",
  assumption: "assumption assum",
  claim: "claim",
  condition: "condition cond",
  hypothesis: "hypothesis hyp",
  remark: "remark",
  example: "example",
};

/** Suggestion for a theorem/definition/assumption/… statement (inserts a callout). */
function statementSuggestion(s: ExtractedStatement, index: number): Suggestion {
  const label = `${s.kind}${s.number ? " " + s.number : ""}`; // "Theorem 1"
  const body = s.text
    .replace(/\$\$[\s\S]*?\$\$/g, " ") // drop display math from the preview
    .replace(/\s+/g, " ")
    .replace(new RegExp("^" + escapeRegExp(label) + "[.:]?\\s*", "i"), "")
    .trim();
  const shown = body ? `${label} — ${body}` : label;
  const display = shown.length > 84 ? shown.slice(0, 83) + "…" : shown;

  const aliases = STATEMENT_ALIASES[s.kind.toLowerCase()] ?? s.kind.toLowerCase();
  // Statement text without the leading "Theorem 1." (the label carries it).
  const renderBody = s.text
    .replace(new RegExp("^" + escapeRegExp(label) + "[.:]?\\s*", "i"), "")
    .trim();
  const render: SuggestionRender = {
    type: "statement",
    kind: s.kind,
    label,
    number: s.number ?? "",
    body: renderBody,
  };

  return {
    kind: "statement",
    label: display,
    detail: [label, s.page !== null ? `p.${s.page + 1}` : null]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, s.page ?? undefined),
    render,
    score: 950 - index,
    searchKey: normalizeMath(`${s.kind} ${s.number ?? ""} ${aliases} ${body}`),
    page: s.page ?? undefined,
  };
}

/** Suggestion that embeds a saved figure/table/chart image + caption. */
function figureSuggestion(
  vaultPath: string,
  fig: ExtractedFigure,
  index: number
): Suggestion {
  const kindLabel = fig.kind.charAt(0).toUpperCase() + fig.kind.slice(1);
  const cap = fig.caption ?? `${kindLabel} (p.${(fig.page ?? 0) + 1})`;
  const shortCap = cap.length > 70 ? cap.slice(0, 69) + "…" : cap;
  const render: SuggestionRender = {
    type: "figure",
    path: vaultPath,
    caption: fig.caption ?? "",
    figKind: fig.kind,
  };
  return {
    kind: "figure-image",
    label: `🖼 ${shortCap}`,
    detail: [kindLabel, fig.page !== null ? `p.${fig.page + 1}` : null]
      .filter(Boolean)
      .join(" · "),
    insert: renderInsert(render, DEFAULT_SETTINGS, fig.page ?? undefined),
    render,
    score: 700 - index,
    searchKey: normalizeMath(`${fig.kind} figure ${fig.caption ?? ""}`),
    page: fig.page ?? undefined,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bidirectional wikilink to a literature note, aliased to the @citekey. */
function wikilink(note: TFile, citekey: string): string {
  return `[[${note.basename}|@${citekey}]]`;
}

/** Placeholder fields for literature-note filename/body templates. */
function noteFields(item: ZoteroItem, citekey: string): Record<string, string> {
  const authors = (item.creators ?? [])
    .filter((c) => !c.creatorType || c.creatorType === "author")
    .map((c) => [c.lastName, c.firstName].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
  return {
    citekey,
    zoteroKey: item.key,
    title: (item.title ?? "").replace(/"/g, "'"),
    authors,
    year: item.date?.match(/\d{4}/)?.[0] ?? "",
    abstract: item.abstractNote ?? "",
    doi: item.DOI ?? "",
    url: item.url ?? "",
  };
}

/** Fill a {placeholder} template (reuses the insert-template renderer). */
function fillTemplate(tpl: string, fields: Record<string, string>): string {
  return renderTemplate(tpl, fields);
}

/** Strip characters not allowed in vault filenames. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength
  ) as ArrayBuffer;
}

// ---- merge helpers for ranged/incremental extraction ------------------

function eqKey(s: Suggestion): string {
  return s.render?.type === "equation" ? s.render.latex : s.insert;
}
function stKey(s: Suggestion): string {
  const label = s.render?.type === "statement" ? s.render.label : s.label;
  return `${label}|${s.page ?? ""}`;
}
function figKey(s: Suggestion): string {
  return `${s.label}|${s.page ?? ""}`;
}

/** Append incoming items not already present (by key), then re-order by page
 *  and re-score so document order is preserved across merged ranges. */
function mergeSuggestions(
  existing: Suggestion[],
  incoming: Suggestion[],
  keyFn: (s: Suggestion) => string,
  base: number
): Suggestion[] {
  const seen = new Set(existing.map(keyFn));
  const merged = existing.slice();
  for (const s of incoming) {
    const k = keyFn(s);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(s);
    }
  }
  merged.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9));
  merged.forEach((s, i) => (s.score = base - i));
  return merged;
}

function mergeBlocks(existing: BlockEntry[], incoming: BlockEntry[]): BlockEntry[] {
  const key = (b: BlockEntry) => `${b.heading ?? ""}|${b.text.slice(0, 80)}`;
  const seen = new Set(existing.map(key));
  const merged = existing.slice();
  for (const b of incoming) {
    const k = key(b);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(b);
    }
  }
  merged.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9));
  return merged;
}

function addRange(existing: string[], range: string): string[] {
  return existing.includes(range) ? existing : [...existing, range];
}

/** The aligned page-chunk (1-based "start-end") containing `page1`. */
function chunkFor(page1: number, size: number): string {
  const start = Math.floor((page1 - 1) / size) * size + 1;
  return `${start}-${start + size - 1}`;
}

/** Is a 1-based page covered by any of the range specs ("101-200", "5,8-9")? */
function pageInRanges(page1: number, ranges: string[]): boolean {
  for (const r of ranges) {
    for (const part of r.split(",")) {
      const [a, b] = part.split("-").map((x) => parseInt(x.trim(), 10));
      if (isNaN(a)) continue;
      const hi = isNaN(b) ? a : b;
      if (page1 >= a && page1 <= hi) return true;
    }
  }
  return false;
}

/** Backfill a suggestion's 0-based page from its "p.N" detail if missing. */
function backfillPage(s: Suggestion): Suggestion {
  if (typeof s.page === "number") return s;
  const m = s.detail?.match(/p\.(\d+)/);
  return m ? { ...s, page: parseInt(m[1], 10) - 1 } : s;
}

/** Substitute {placeholders}; multi-line values inherit the line's `>`/indent
 *  prefix so callout/blockquote bodies stay properly quoted. */
function renderTemplate(tpl: string, fields: Record<string, string>): string {
  return tpl
    .split("\n")
    .map((line) => {
      const contPrefix = line.match(/^(\s*(?:>\s?)*)/)?.[1] ?? "";
      return line.replace(/\{(\w+)\}/g, (_m, key) =>
        (fields[key] ?? "").replace(/\n/g, "\n" + contPrefix)
      );
    })
    .join("\n");
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderFields(r: SuggestionRender, page?: number): Record<string, string> {
  const pageStr = typeof page === "number" ? String(page + 1) : "";
  if (r.type === "statement") {
    return {
      kind: r.kind.toLowerCase(),
      Kind: capFirst(r.kind),
      label: r.label,
      number: r.number,
      body: r.body,
      page: pageStr,
    };
  }
  if (r.type === "equation") {
    return {
      latex: r.latex,
      latexInline: r.latex.replace(/\s*\n\s*/g, " ").trim(),
      tag: r.tag,
      page: pageStr,
    };
  }
  return {
    path: r.path,
    caption: r.caption,
    kind: r.figKind,
    Kind: capFirst(r.figKind),
    page: pageStr,
  };
}

function templateFor(r: SuggestionRender, s: ZobSettings): string {
  if (r.type === "statement") {
    return s.statementFormat === "custom"
      ? s.statementTemplate
      : STATEMENT_TEMPLATES[s.statementFormat] ?? STATEMENT_TEMPLATES.callout;
  }
  if (r.type === "equation") {
    return s.equationFormat === "custom"
      ? s.equationTemplate
      : EQUATION_TEMPLATES[s.equationFormat] ?? EQUATION_TEMPLATES.block;
  }
  return s.figureFormat === "custom"
    ? s.figureTemplate
    : FIGURE_TEMPLATES[s.figureFormat] ?? FIGURE_TEMPLATES["embed-caption"];
}

/** Render a suggestion's insert text from the chosen (preset or custom) template. */
function renderInsert(
  r: SuggestionRender,
  s: ZobSettings,
  page?: number
): string {
  const out = renderTemplate(templateFor(r, s), renderFields(r, page));
  return out.replace(/\n*$/, "") + "\n";
}

/** Reconstruct a render payload for cached statement/figure suggestions that
 *  predate it, by parsing their baked insert — so the format setting applies
 *  without re-extraction. */
function backfillRender(s: Suggestion): Suggestion {
  if (s.render) return s;
  if (s.kind === "statement") {
    const m = s.insert.match(/^>\s*\[!(\w+)\]\s*(.+)/);
    if (!m) return s;
    const kind = m[1];
    const label = m[2].trim();
    const body = s.insert
      .split("\n")
      .slice(1)
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim()
      .replace(new RegExp("^" + escapeRegExp(label) + "[.:]?\\s*", "i"), "")
      .trim();
    const number = label.match(/\d+(?:\.\d+)*/)?.[0] ?? "";
    return { ...s, render: { type: "statement", kind, label, number, body } };
  }
  if (s.kind === "figure-image") {
    const m = s.insert.match(/!\[\[([^\]]+)\]\]/);
    if (!m) return s;
    const caption = s.insert.match(/\*([^*\n]+)\*/)?.[1] ?? "";
    return {
      ...s,
      render: { type: "figure", path: m[1], caption, figKind: "figure" },
    };
  }
  return s;
}
