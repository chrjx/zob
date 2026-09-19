import { App, PluginSettingTab, Setting } from "obsidian";
import type ZobPlugin from "./main";

export interface ZobSettings {
  /** Port of Zotero's local HTTP server (default 23119). */
  zoteroPort: number;
  /** Zotero data directory (for reconstructing PDF paths without the bridge). */
  zoteroDataDir: string;
  /** Without the bridge, auto-track the most recently modified paper. */
  autoTrackRecent: boolean;
  /** How often to poll Zotero for the current reader item, in ms. */
  pollIntervalMs: number;
  /** Free MinerU cloud API token (for equation -> LaTeX extraction). */
  mineruToken: string;
  /** Embedding backend for semantic block search. */
  embedderBackend: "voyage" | "ollama";
  /** Voyage API key for semantic block search (free tier works). */
  voyageApiKey: string;
  /** Voyage embedding model. */
  embedModel: string;
  /** Ollama server URL (local embeddings). */
  ollamaUrl: string;
  /** Ollama embedding model. */
  ollamaModel: string;
  /** Master toggle for equation extraction (off = citations/terms/figures only). */
  enableEquations: boolean;
  /** Which extractor backend to use (pluggable; MinerU is the first). */
  extractorBackend: "mineru";
  /** Auto-extract the page-chunk around the current reading page (needs the bridge). */
  autoExtract: boolean;
  /** Pages per auto-extraction chunk (MinerU caps a request at 200 pages). */
  autoExtractChunkSize: number;
  /** Max size (MB) of the parsed-equation cache before least-recently-used papers are evicted. */
  cacheMaxMB: number;
  /** Append a zotero:// page backlink to inserted equations/figures/statements. */
  insertBacklinks: boolean;
  /** Insert format for theorem/definition/… statements. */
  statementFormat: "callout" | "blockquote" | "bold" | "heading" | "plain" | "custom";
  /** Custom statement template (used when statementFormat = "custom"). */
  statementTemplate: string;
  /** Insert format for equations. */
  equationFormat: "block" | "inline" | "custom";
  /** Custom equation template. */
  equationTemplate: string;
  /** Insert format for figures/tables. */
  figureFormat: "embed-caption" | "embed" | "image-caption" | "custom";
  /** Custom figure template. */
  figureTemplate: string;
  /** Trigger character for citation autocomplete. */
  citationTrigger: string;
  /** Trigger string for paper-context autocomplete (terms/figures/equations). */
  paperTrigger: string;
  /** Trigger string for semantic block autocomplete (whole paragraphs). */
  blockTrigger: string;
  /** Frontmatter property holding a note's Better BibTeX citekey. */
  citekeyProperty: string;
  /** Frontmatter property holding a note's Zotero item key. */
  zoteroKeyProperty: string;
  /** Folder for Zob-created literature notes. */
  literatureFolder: string;
  /** Filename template for created literature notes (placeholders below). */
  noteFilenameTemplate: string;
  /** Body template for created literature notes. */
  noteTemplate: string;
}

/** Preset insert templates. Placeholders are {name}; lines starting with `>`
 *  auto-prefix multi-line values (so callout/blockquote bodies stay quoted). */
export const STATEMENT_TEMPLATES: Record<string, string> = {
  callout: "> [!{kind}] {label}\n> {body}",
  blockquote: "> **{label}.** {body}",
  bold: "**{label}.** {body}",
  heading: "### {label}\n{body}",
  plain: "{label}. {body}",
};
export const EQUATION_TEMPLATES: Record<string, string> = {
  block: "$$\n{latex}\n$$",
  inline: "${latexInline}$",
};
export const FIGURE_TEMPLATES: Record<string, string> = {
  "embed-caption": "![[{path}]]\n*{caption}*",
  embed: "![[{path}]]",
  "image-caption": "![{caption}]({path})",
};

export const DEFAULT_SETTINGS: ZobSettings = {
  zoteroPort: 23119,
  zoteroDataDir: `${process.env.HOME ?? ""}/Zotero`,
  autoTrackRecent: true,
  pollIntervalMs: 2000,
  mineruToken: "",
  embedderBackend: "voyage",
  voyageApiKey: "",
  embedModel: "voyage-3.5-lite",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "nomic-embed-text",
  enableEquations: true,
  extractorBackend: "mineru",
  autoExtract: false,
  autoExtractChunkSize: 100,
  cacheMaxMB: 25,
  insertBacklinks: true,
  statementFormat: "callout",
  statementTemplate: STATEMENT_TEMPLATES.callout,
  equationFormat: "block",
  equationTemplate: EQUATION_TEMPLATES.block,
  figureFormat: "embed-caption",
  figureTemplate: FIGURE_TEMPLATES["embed-caption"],
  citationTrigger: "@",
  paperTrigger: ";;",
  blockTrigger: "::",
  citekeyProperty: "citekey",
  zoteroKeyProperty: "zotero-key",
  literatureFolder: "Zotero",
  noteFilenameTemplate: "@{citekey}",
  noteTemplate: [
    "---",
    "citekey: {citekey}",
    "zotero-key: {zoteroKey}",
    'title: "{title}"',
    "authors: {authors}",
    "year: {year}",
    "---",
    "",
    "# {title}",
    "",
    "{abstract}",
    "",
  ].join("\n"),
};

export class ZobSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ZobPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const status = containerEl.createEl("p", {
      cls: "zob-settings-status",
      text: "Checking capabilities…",
    });
    void (async () => {
      const bridge = await this.plugin.bridge.ping();
      const zotero = bridge || (await this.plugin.bridge.zoteroAlive());
      const extractor =
        this.plugin.settings.enableEquations &&
        !!this.plugin.settings.mineruToken;
      const line = (on: boolean, name: string, hint: string) =>
        on ? `✓ ${name}` : `○ ${name} — ${hint}`;
      status.setText(
        [
          line(zotero, "Base (Zotero)", "start Zotero"),
          line(bridge, "Live (Zob Bridge)", "install the bridge xpi"),
          line(extractor, "Content (extractor)", "set a MinerU token below"),
        ].join("\n")
      );
    })();

    new Setting(containerEl)
      .setName("Zotero port")
      .setDesc("Port of Zotero's local server. Default 23119.")
      .addText((t) =>
        t
          .setPlaceholder("23119")
          .setValue(String(this.plugin.settings.zoteroPort))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n)) {
              this.plugin.settings.zoteroPort = n;
              this.plugin.bridge.setPort(n);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Zotero data directory")
      .setDesc(
        "Used to locate PDF files when the Zob Bridge isn't installed. Default ~/Zotero."
      )
      .addText((t) =>
        t
          .setPlaceholder(`${process.env.HOME ?? ""}/Zotero`)
          .setValue(this.plugin.settings.zoteroDataDir)
          .onChange(async (v) => {
            this.plugin.settings.zoteroDataDir = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-track recent paper (no bridge)")
      .setDesc(
        "Without the Zob Bridge, follow the most recently modified paper in Zotero. Turn off to only use the manually set paper."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoTrackRecent).onChange(async (v) => {
          this.plugin.settings.autoTrackRecent = v;
          await this.plugin.saveSettings();
          void this.plugin.refreshCurrent();
        })
      );

    new Setting(containerEl)
      .setName("Fallback poll interval (ms)")
      .setDesc(
        "Updates are normally pushed instantly when you switch tabs in Zotero. This timer is only a fallback, used if your Zotero bridge is too old to support push."
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.pollIntervalMs))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 500) {
              this.plugin.settings.pollIntervalMs = n;
              await this.plugin.saveSettings();
              this.plugin.restartPolling();
            }
          })
      );

    new Setting(containerEl)
      .setName("Citation trigger")
      .setDesc("Character that opens citation autocomplete (e.g. @).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.citationTrigger)
          .onChange(async (v) => {
            this.plugin.settings.citationTrigger = v.slice(0, 1) || "@";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Paper trigger")
      .setDesc(
        "Opens autocomplete for terms, figures, and equations from the paper you're reading (e.g. ;;)."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.paperTrigger)
          .onChange(async (v) => {
            this.plugin.settings.paperTrigger = v.slice(0, 4) || ";;";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Block trigger")
      .setDesc(
        "Type a phrase/concept to import a whole matching paragraph (with its equations), ranked semantically (e.g. ::profit maximization). Use a string that doesn't collide with the paper trigger."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.blockTrigger)
          .onChange(async (v) => {
            this.plugin.settings.blockTrigger = v.slice(0, 4) || "::";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Citekey property")
      .setDesc(
        "Frontmatter key that holds a note's citekey. Citations link to a note that has this (or the Zotero-key property)."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.citekeyProperty)
          .onChange(async (v) => {
            this.plugin.settings.citekeyProperty = v.trim() || "citekey";
            await this.plugin.saveSettings();
            this.plugin.rebuildNoteIndex();
          })
      );

    new Setting(containerEl)
      .setName("Zotero-key property")
      .setDesc(
        "Frontmatter key that holds a note's Zotero item key (the reliable match — works even without Better BibTeX)."
      )
      .addText((t) =>
        t
          .setValue(this.plugin.settings.zoteroKeyProperty)
          .onChange(async (v) => {
            this.plugin.settings.zoteroKeyProperty = v.trim() || "zotero-key";
            await this.plugin.saveSettings();
            this.plugin.rebuildNoteIndex();
          })
      );

    new Setting(containerEl)
      .setName("Literature-note folder")
      .setDesc("Folder for notes created by Zob (matches ZotLit's if you use it).")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.literatureFolder)
          .onChange(async (v) => {
            this.plugin.settings.literatureFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Note filename template")
      .setDesc("Placeholders: {citekey} {zoteroKey} {title} {year} {authors}.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.noteFilenameTemplate)
          .onChange(async (v) => {
            this.plugin.settings.noteFilenameTemplate = v || "@{citekey}";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Note body template")
      .setDesc(
        "Content for created notes. Placeholders: {citekey} {zoteroKey} {title} {authors} {year} {abstract} {doi} {url}."
      )
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.noteTemplate).onChange(async (v) => {
          this.plugin.settings.noteTemplate = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 8;
        t.inputEl.addClass("zob-template-input");
      });

    new Setting(containerEl)
      .setName("Insert Zotero backlinks")
      .setDesc(
        "Append a zotero:// link (jumps to the page in Zotero's reader) after inserted equations, figures and statements."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.insertBacklinks).onChange(async (v) => {
          this.plugin.settings.insertBacklinks = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Insert formats").setHeading();

    const wideTextArea = (
      get: () => string,
      set: (v: string) => Promise<void>
    ) => (t: any) => {
      t.setValue(get()).onChange(async (v: string) => set(v));
      t.inputEl.rows = 2;
      t.inputEl.addClass("zob-template-input");
    };

    new Setting(containerEl)
      .setName("Statement format")
      .setDesc("Preset, or Custom to use your own template below.")
      .addDropdown((d) =>
        d
          .addOption("callout", "Callout  > [!theorem]")
          .addOption("blockquote", "Blockquote  > **Theorem 1.**")
          .addOption("bold", "Bold inline")
          .addOption("heading", "Heading  ### Theorem 1")
          .addOption("plain", "Plain text")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.statementFormat)
          .onChange(async (v) => {
            this.plugin.settings.statementFormat =
              v as ZobSettings["statementFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom statement template")
      .setDesc(
        "Placeholders: {kind} {Kind} {label} {number} {body} {page}. Lines starting with > auto-quote multi-line values."
      )
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.statementTemplate,
          async (v) => {
            this.plugin.settings.statementTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    new Setting(containerEl)
      .setName("Equation format")
      .addDropdown((d) =>
        d
          .addOption("block", "Display block  $$…$$")
          .addOption("inline", "Inline  $…$")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.equationFormat)
          .onChange(async (v) => {
            this.plugin.settings.equationFormat =
              v as ZobSettings["equationFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom equation template")
      .setDesc("Placeholders: {latex} {latexInline} {tag} {page}.")
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.equationTemplate,
          async (v) => {
            this.plugin.settings.equationTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    new Setting(containerEl)
      .setName("Figure format")
      .addDropdown((d) =>
        d
          .addOption("embed-caption", "Embed + caption")
          .addOption("embed", "Embed only")
          .addOption("image-caption", "Markdown image + caption")
          .addOption("custom", "Custom template ↓")
          .setValue(this.plugin.settings.figureFormat)
          .onChange(async (v) => {
            this.plugin.settings.figureFormat =
              v as ZobSettings["figureFormat"];
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("↳ Custom figure template")
      .setDesc("Placeholders: {path} {caption} {kind} {Kind} {page}.")
      .addTextArea(
        wideTextArea(
          () => this.plugin.settings.figureTemplate,
          async (v) => {
            this.plugin.settings.figureTemplate = v;
            await this.plugin.saveSettings();
          }
        )
      );

    new Setting(containerEl).setName("Equations").setHeading();

    new Setting(containerEl)
      .setName("Enable equation extraction")
      .setDesc("Extract equations from the PDF as LaTeX via MinerU.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableEquations).onChange(async (v) => {
          this.plugin.settings.enableEquations = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("MinerU API token")
      .setDesc("Free token from mineru.net. Note: the cloud API uploads the PDF to MinerU's servers.")
      .addText((t) =>
        t
          .setPlaceholder("mineru token")
          .setValue(this.plugin.settings.mineruToken)
          .onChange(async (v) => {
            this.plugin.settings.mineruToken = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-extract around current page")
      .setDesc(
        "As you read (needs the Zob Bridge for the live page), automatically extract the page-chunk you're in and merge it — extracting further chunks as you read on. Uploads those pages to MinerU."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoExtract).onChange(async (v) => {
          this.plugin.settings.autoExtract = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-extract chunk size (pages)")
      .setDesc("Pages per auto-extraction. MinerU caps a single request at 200.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoExtractChunkSize))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 10 && n <= 200) {
              this.plugin.settings.autoExtractChunkSize = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Equation cache limit (MB)")
      .setDesc(
        "Parsed equations are cached per paper so a PDF is only sent to MinerU once. When the cache exceeds this size, the least-recently-used papers are evicted."
      )
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.cacheMaxMB))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 1) {
              this.plugin.settings.cacheMaxMB = n;
              await this.plugin.saveSettings();
              if (this.plugin.enforceCacheLimit()) {
                await this.plugin.saveEqCache();
              }
            }
          })
      );

    new Setting(containerEl).setName("Semantic block import").setHeading();

    new Setting(containerEl)
      .setName("Embedding backend")
      .setDesc(
        "Powers 'Import block…'. Ollama = local, no key, no limits (run 'ollama serve'). Voyage = cloud free tier (sends text to Voyage)."
      )
      .addDropdown((d) =>
        d
          .addOption("voyage", "Voyage (cloud)")
          .addOption("ollama", "Ollama (local, no key)")
          .setValue(this.plugin.settings.embedderBackend)
          .onChange(async (v) => {
            this.plugin.settings.embedderBackend =
              v as ZobSettings["embedderBackend"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ollama server URL")
      .setDesc("Local Ollama endpoint. Default http://localhost:11434.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.ollamaUrl)
          .onChange(async (v) => {
            this.plugin.settings.ollamaUrl = v.trim() || "http://localhost:11434";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ollama model")
      .setDesc("Embedding model to pull/use, e.g. nomic-embed-text or bge-small.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.ollamaModel)
          .onChange(async (v) => {
            this.plugin.settings.ollamaModel = v.trim() || "nomic-embed-text";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Voyage API key")
      .setDesc(
        "Used when backend = Voyage. Free tier from voyageai.com works. Block text is sent to Voyage to embed."
      )
      .addText((t) =>
        t
          .setPlaceholder("pa-…")
          .setValue(this.plugin.settings.voyageApiKey)
          .onChange(async (v) => {
            this.plugin.settings.voyageApiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc("Voyage model for block search. Default voyage-3.5-lite.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.embedModel)
          .onChange(async (v) => {
            this.plugin.settings.embedModel = v.trim() || "voyage-3.5-lite";
            await this.plugin.saveSettings();
          })
      );
  }
}
