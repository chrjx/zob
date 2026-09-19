import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from "obsidian";
import type ZobPlugin from "./main";
import { Suggestion } from "./paper-index";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A single EditorSuggest that handles three triggers:
 *   - the citation trigger (default "@")   -> searches the Zotero library
 *   - the paper trigger    (default ";;")  -> terms / figures / equations
 *                                             from the paper open in Zotero
 *   - the block trigger    (default "::")  -> a whole matching paragraph
 *                                             (with equations), ranked semantically
 */
export class ZobSuggest extends EditorSuggest<Suggestion> {
  constructor(private plugin: ZobPlugin) {
    super(plugin.app);
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const paperTrig = this.plugin.settings.paperTrigger || ";;";
    const citeTrig = this.plugin.settings.citationTrigger || "@";
    const blockTrig = this.plugin.settings.blockTrigger || "::";

    // Block trigger: "::phrase". It is checked first so users may deliberately
    // configure an overlapping custom trigger without ambiguity.
    if (blockTrig && blockTrig !== paperTrig) {
      const blockRe = new RegExp(escapeRe(blockTrig) + "([\\w .()-]*)$");
      const bm = line.match(blockRe);
      if (bm) {
        return {
          start: { line: cursor.line, ch: cursor.ch - bm[0].length },
          end: cursor,
          query: "block:" + bm[1],
        };
      }
    }

    // Paper trigger: ";;query"
    const paperRe = new RegExp(escapeRe(paperTrig) + "([\\w .()-]*)$");
    const pm = line.match(paperRe);
    if (pm) {
      return {
        start: { line: cursor.line, ch: cursor.ch - pm[0].length },
        end: cursor,
        query: "paper:" + pm[1],
      };
    }

    // Citation trigger: "@query" preceded by start-of-line or whitespace.
    const citeRe = new RegExp("(?:^|\\s)" + escapeRe(citeTrig) + "([\\w-]*)$");
    const cm = line.match(citeRe);
    if (cm) {
      const at = cursor.ch - cm[1].length - citeTrig.length;
      return {
        start: { line: cursor.line, ch: at },
        end: cursor,
        query: "cite:" + cm[1],
      };
    }

    return null;
  }

  async getSuggestions(context: EditorSuggestContext): Promise<Suggestion[]> {
    const sep = context.query.indexOf(":");
    const mode = context.query.slice(0, sep);
    const q = context.query.slice(sep + 1);
    if (mode === "cite") {
      return this.plugin.getCitationSuggestions(q);
    }
    if (mode === "block") {
      return this.plugin.getBlockSuggestions(q);
    }
    return this.plugin.getPaperSuggestions(q);
  }

  renderSuggestion(s: Suggestion, el: HTMLElement): void {
    el.addClass("zob-suggestion");
    // Blocks: show heading·page as the header and the paragraph preview as body.
    if (s.kind === "block") {
      if (s.detail) el.createDiv({ cls: "zob-suggestion-kind", text: s.detail });
      el.createDiv({ cls: "zob-suggestion-title", text: s.label });
      return;
    }
    el.createDiv({ cls: "zob-suggestion-kind", text: s.kind });
    if (s.kind === "equation") {
      el.createEl("code", { cls: "zob-suggestion-title", text: s.label });
    } else {
      el.createDiv({ cls: "zob-suggestion-title", text: s.label });
    }
    if (s.detail) {
      el.createDiv({ cls: "zob-suggestion-meta", text: s.detail });
    }
  }

  selectSuggestion(s: Suggestion, _evt: MouseEvent | KeyboardEvent): void {
    const ctx = this.context;
    if (!ctx) return;

    // Some rows trigger an action (e.g. kick off MinerU extraction) rather
    // than inserting text. Remove the trigger text and run it.
    if (s.action === "extract-equations") {
      ctx.editor.replaceRange("", ctx.start, ctx.end);
      this.close();
      void this.plugin.extractPaper();
      return;
    }

    // Create a literature note, then replace the trigger with a wikilink to it.
    if (s.action === "create-note" && s.citeItemKey) {
      const { editor, start, end } = ctx;
      this.close();
      void this.plugin.createNoteAndLink(
        s.citeItemKey,
        s.citeKey ?? "",
        editor,
        start,
        end
      );
      return;
    }

    const text = this.plugin.insertTextFor(s);
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    const lines = text.split("\n");
    const end: EditorPosition =
      lines.length === 1
        ? { line: ctx.start.line, ch: ctx.start.ch + text.length }
        : {
            line: ctx.start.line + lines.length - 1,
            ch: lines[lines.length - 1].length,
          };
    ctx.editor.setCursor(end);
    this.close();
  }
}
