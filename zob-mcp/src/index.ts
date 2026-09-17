#!/usr/bin/env node
/**
 * Zob MCP server — exposes the Zotero paper you're reading to any MCP client
 * (Claude Code, Codex, Cursor, Claudian, …). Tools:
 *   current_paper     — what's open in Zotero's reader (+ what's extracted)
 *   search_library    — find any paper in the library by title/author/year
 *   list_annotations  — your highlights (text, comment, color, page, key)
 *   get_content       — equations / statements / figures from Zob's cache
 *   get_blocks        — prose+equation blocks for semantic import
 *   get_fulltext      — the PDF's extracted text (Zotero fulltext index)
 *   insert_into_note  — write Markdown back into the vault
 *
 * Config via env: ZOB_ZOTERO_PORT (default 23119), ZOB_ZOTERO_USER
 * (default "0" — the local-API alias), ZOB_VAULT (path to the Obsidian vault,
 * needed by get_content to read the plugin's cache).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const ZOTERO_PORT = process.env.ZOB_ZOTERO_PORT ?? "23119";
const ZOTERO_USER = process.env.ZOB_ZOTERO_USER ?? "0";
const VAULT = process.env.ZOB_VAULT ?? "";
const INBOX = process.env.ZOB_INBOX ?? "Zob Inbox.md";
const BASE = `http://127.0.0.1:${ZOTERO_PORT}`;
const HEADERS = { "Zotero-Allowed-Request": "true" };

async function zoteroGet(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Zotero ${path} → HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

async function currentReading(): Promise<any> {
  return zoteroGet("/zob/current");
}

async function resolveKey(attachmentKey?: string): Promise<string> {
  if (attachmentKey) return attachmentKey;
  const cur = await currentReading();
  const key = cur?.attachment?.key;
  if (!key) {
    throw new Error("No PDF open in Zotero, and no attachmentKey was given.");
  }
  return key;
}

async function readCache(): Promise<Record<string, any>> {
  if (!VAULT) {
    throw new Error("ZOB_VAULT is not set (needed to read extracted content).");
  }
  const p = join(
    VAULT,
    ".obsidian",
    "plugins",
    "zob",
    "equation-cache.json"
  );
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return {};
  }
}

function text(obj: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function errText(e: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${e instanceof Error ? e.message : String(e)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({ name: "zob", version: "0.1.0" });

server.registerTool(
  "current_paper",
  {
    description:
      "The paper currently open in the Zotero reader: title, authors, date, DOI, abstract, citation key, the attachmentKey (use it with the other tools), and the current page.",
    inputSchema: {},
  },
  async () => {
    try {
      const cur = await currentReading();
      const it = cur?.item ?? {};
      const attKey = cur?.attachment?.key;
      // Surface what's already extracted so the agent knows whether to use
      // get_content/get_blocks or ask for extraction first.
      let coveredRanges: any[] | undefined;
      let extracted = false;
      if (attKey && VAULT) {
        try {
          const entry = (await readCache())[attKey];
          if (entry) {
            extracted = true;
            coveredRanges = entry.coveredRanges ?? [];
          }
        } catch {
          /* cache optional */
        }
      }
      return text({
        open: cur?.open,
        title: it.title,
        creators: it.creators,
        date: it.date,
        DOI: it.DOI,
        url: it.url,
        publicationTitle: it.publicationTitle,
        abstract: it.abstractNote,
        citationKey: it.citationKey,
        attachmentKey: attKey,
        page: cur?.page,
        selectedAnnotations: cur?.selectedAnnotations ?? [],
        extracted,
        coveredRanges: coveredRanges ?? [],
      });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_annotations",
  {
    description:
      "List reader annotations (highlights) on the current paper — or a given attachmentKey. Each has: highlighted text, your comment, color (hex), page, annotation key, and a zotero:// backlink. Filter by color, or set selectedOnly to return just the annotation(s) currently selected in the reader.",
    inputSchema: {
      attachmentKey: z.string().optional(),
      color: z.string().optional(),
      selectedOnly: z.boolean().optional(),
    },
  },
  async ({ attachmentKey, color, selectedOnly }) => {
    try {
      const key = await resolveKey(attachmentKey);
      let selected: Set<string> | null = null;
      if (selectedOnly) {
        const cur = await currentReading();
        selected = new Set<string>(cur?.selectedAnnotations ?? []);
      }
      // Annotations are excluded from the default /children listing — filter for them.
      const children = await zoteroGet(
        `/api/users/${ZOTERO_USER}/items/${key}/children?itemType=annotation`
      );
      const anns = (Array.isArray(children) ? children : [])
        .filter((c: any) => c?.data?.itemType === "annotation")
        .map((c: any) => {
          const d = c.data;
          return {
            key: c.key,
            type: d.annotationType,
            color: d.annotationColor,
            page: d.annotationPageLabel,
            text: d.annotationText,
            comment: d.annotationComment,
            backlink: `zotero://open-pdf/library/items/${key}?annotation=${c.key}`,
          };
        })
        .filter(
          (a: any) =>
            !color || (a.color ?? "").toLowerCase() === color.toLowerCase()
        )
        .filter((a: any) => !selected || selected.has(a.key));
      return text({ attachmentKey: key, count: anns.length, annotations: anns });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_library",
  {
    description:
      "Search your whole Zotero library by title / author / year (not just the open paper). Returns candidate papers with title, creators, date, citation key, a zotero:// backlink, and — when available — the best PDF attachmentKey to pass to get_content / get_blocks / list_annotations. Use this to pull up a paper other than the one currently open in the reader.",
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
    },
  },
  async ({ query, limit }) => {
    try {
      const cap = Math.max(1, Math.min(limit ?? 8, 25));
      const rows = await zoteroGet(
        `/api/users/${ZOTERO_USER}/items/top?q=${encodeURIComponent(
          query
        )}&qmode=titleCreatorYear&limit=${cap}`
      );
      const items = (Array.isArray(rows) ? rows : []).filter(
        (r: any) =>
          r?.data?.itemType !== "attachment" && r?.data?.itemType !== "note"
      );
      const results = await Promise.all(
        items.map(async (r: any) => {
          const d = r.data ?? {};
          let attachmentKey: string | undefined;
          try {
            const kids = await zoteroGet(
              `/api/users/${ZOTERO_USER}/items/${r.key}/children`
            );
            const pdf = (Array.isArray(kids) ? kids : []).find(
              (c: any) =>
                c?.data?.itemType === "attachment" &&
                /pdf/i.test(c?.data?.contentType ?? "")
            );
            attachmentKey = pdf?.key;
          } catch {
            /* attachment optional */
          }
          return {
            key: r.key,
            itemType: d.itemType,
            title: d.title,
            date: d.date,
            creators: (d.creators ?? []).map((c: any) => ({
              firstName: c.firstName,
              lastName: c.lastName ?? c.name,
            })),
            citationKey: d.citationKey ?? r.meta?.citationKey,
            attachmentKey,
            backlink: `zotero://select/library/items/${r.key}`,
          };
        })
      );
      return text({ count: results.length, results });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_content",
  {
    description:
      "Extracted content for the current paper (or attachmentKey) from Zob's MinerU cache: equations (LaTeX), statements (theorems/definitions/assumptions), figures. Each item carries the ready-to-insert markdown and page. Filter by kind and/or a text query.",
    inputSchema: {
      attachmentKey: z.string().optional(),
      kind: z.enum(["equation", "statement", "figure", "all"]).optional(),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async ({ attachmentKey, kind, query, limit }) => {
    try {
      const key = await resolveKey(attachmentKey);
      const entry = (await readCache())[key];
      if (!entry) {
        return text({
          attachmentKey: key,
          note: "No extracted content cached — run 'Extract this paper' in Obsidian first.",
          equations: [],
          statements: [],
          figures: [],
        });
      }
      const pick = (arr: any[] = []) => {
        let items = arr.map((s) => ({
          kind: s.kind,
          label: s.label,
          page: typeof s.page === "number" ? s.page + 1 : undefined,
          markdown: s.insert,
        }));
        if (query) {
          const q = query.toLowerCase();
          items = items.filter(
            (s) =>
              (s.label ?? "").toLowerCase().includes(q) ||
              (s.markdown ?? "").toLowerCase().includes(q)
          );
        }
        if (typeof limit === "number") items = items.slice(0, limit);
        return items;
      };
      const want = kind ?? "all";
      const out: any = { attachmentKey: key, coveredRanges: entry.coveredRanges ?? [] };
      if (want === "all" || want === "equation") out.equations = pick(entry.equations);
      if (want === "all" || want === "statement") out.statements = pick(entry.statements);
      if (want === "all" || want === "figure") out.figures = pick(entry.figures);
      return text(out);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_blocks",
  {
    description:
      "Prose blocks (a paragraph plus its equations, tagged with the section heading) for the current paper, from Zob's cache. Use this to import a whole block by meaning: read the blocks, pick the one matching the user's phrase/concept, and return its markdown. Optional query does a lexical prefilter; you do the semantic selection.",
    inputSchema: {
      attachmentKey: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async ({ attachmentKey, query, limit }) => {
    try {
      const key = await resolveKey(attachmentKey);
      const entry = (await readCache())[key];
      const blocks: any[] = entry?.blocks ?? [];
      if (blocks.length === 0) {
        return text({
          attachmentKey: key,
          note: "No blocks cached — run 'Extract paper' in Obsidian first.",
          blocks: [],
        });
      }
      let items = blocks.map((b) => ({
        heading: b.heading,
        page: typeof b.page === "number" ? b.page + 1 : undefined,
        markdown: b.text, // paragraph + equations, ready to insert
      }));
      if (query) {
        const q = query.toLowerCase();
        items = items.filter(
          (b) =>
            (b.heading ?? "").toLowerCase().includes(q) ||
            (b.markdown ?? "").toLowerCase().includes(q)
        );
      }
      items = items.slice(0, typeof limit === "number" ? limit : 50);
      return text({
        attachmentKey: key,
        coveredRanges: entry?.coveredRanges ?? [],
        count: items.length,
        blocks: items,
      });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_fulltext",
  {
    description:
      "The extracted full text of the current paper's PDF (or a given attachmentKey), from Zotero's fulltext index. Truncated to maxChars (default 20000).",
    inputSchema: {
      attachmentKey: z.string().optional(),
      maxChars: z.number().optional(),
    },
  },
  async ({ attachmentKey, maxChars }) => {
    try {
      const key = await resolveKey(attachmentKey);
      const ft = await zoteroGet(
        `/api/users/${ZOTERO_USER}/items/${key}/fulltext`
      );
      const content = typeof ft?.content === "string" ? ft.content : "";
      const cap = maxChars ?? 20000;
      return text(
        content.length > cap
          ? `${content.slice(0, cap)}\n…[truncated; ${content.length} chars total]`
          : content
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "insert_into_note",
  {
    description:
      "Write Markdown into a vault note. mode 'append' (default) / 'prepend' add to an existing note (or the Zob inbox if note_path is omitted); 'create' makes a new note. Returns the path written. The agent normally drafts text (e.g. from list_annotations) and calls this to save it.",
    inputSchema: {
      markdown: z.string(),
      note_path: z.string().optional(),
      mode: z.enum(["append", "prepend", "create"]).optional(),
    },
  },
  async ({ markdown, note_path, mode }) => {
    try {
      if (!VAULT) throw new Error("ZOB_VAULT is not set (needed to write notes).");
      const rel = (note_path ?? INBOX).replace(/^\/+/, "");
      const abs = resolve(VAULT, rel);
      if (!abs.startsWith(resolve(VAULT))) {
        throw new Error("note_path escapes the vault.");
      }
      await mkdir(dirname(abs), { recursive: true });
      const exists = await stat(abs).then(() => true).catch(() => false);
      const m = mode ?? "append";

      if (m === "create") {
        if (exists) throw new Error(`Note already exists: ${rel} (use append).`);
        await writeFile(abs, markdown.endsWith("\n") ? markdown : markdown + "\n");
      } else if (m === "prepend") {
        const prev = exists ? await readFile(abs, "utf8") : "";
        await writeFile(abs, markdown.replace(/\n*$/, "\n\n") + prev);
      } else {
        const sep = exists ? "\n\n" : "";
        await appendFile(abs, sep + markdown.replace(/\n*$/, "\n"));
      }
      return text({ ok: true, path: rel, mode: m });
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerPrompt(
  "summarize_annotation",
  {
    description:
      "Turn the highlight you have selected in Zotero (or the most recent one) into a clean definition/theorem/claim and insert it into your note.",
    argsSchema: { kind: z.string().optional() },
  },
  ({ kind }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Using the zob tools:`,
            `1. Call current_paper to get the paper and its attachmentKey.`,
            `2. Call list_annotations with selectedOnly=true; if none, use the most recent highlight from list_annotations.`,
            `3. Rewrite the highlighted text as a clean, self-contained ${
              kind || "definition/theorem/claim"
            } in Markdown (keep any math as LaTeX). Do not editorialize.`,
            `4. Call insert_into_note with that Markdown, appending the annotation's zotero:// backlink on its own line.`,
          ].join("\n"),
        },
      },
    ],
  })
);

server.registerPrompt(
  "paper_note",
  {
    description:
      "Draft a structured literature note for the paper currently open in Zotero (metadata, key theorems/equations, and your annotations).",
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Build a literature note for the current paper using the zob tools:`,
            `1. current_paper for title/authors/abstract/attachmentKey.`,
            `2. get_content (kind="statement" then "equation") for the key results; get_content(kind="figure") for figures.`,
            `3. list_annotations for my highlights and comments.`,
            `Compose a concise Markdown note: a short summary, the key theorems/definitions (math as LaTeX), and my annotated points. Then call insert_into_note (mode="create", note_path from the citekey) to save it.`,
          ].join("\n"),
        },
      },
    ],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — log to stderr only.
  console.error(
    `[zob-mcp] ready (zotero :${ZOTERO_PORT}, vault: ${VAULT || "unset"})`
  );
}

main().catch((e) => {
  console.error("[zob-mcp] fatal:", e);
  process.exit(1);
});
