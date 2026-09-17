import { requestUrl } from "obsidian";

/**
 * A pluggable text embedder for semantic block search. Voyage (cloud, free
 * tier) is the first backend; a local/offline model can be added behind this
 * same interface later without touching the search code.
 */
export interface Embedder {
  readonly name: string;
  isConfigured(): boolean;
  /**
   * Embed texts. `type` follows Voyage's retrieval convention: "document" for
   * stored blocks, "query" for the search string (improves match quality).
   */
  embed(texts: string[], type: "document" | "query"): Promise<number[][]>;
}

export interface EmbedderConfig {
  backend: "voyage" | "ollama";
  voyageApiKey: string;
  voyageModel: string;
  ollamaUrl: string;
  ollamaModel: string;
}

/** Build the configured embedder, or null if it isn't set up. */
export function createEmbedder(cfg: EmbedderConfig): Embedder | null {
  switch (cfg.backend) {
    case "ollama":
      if (!cfg.ollamaModel) return null;
      return new OllamaEmbedder(
        (cfg.ollamaUrl || "http://localhost:11434").replace(/\/$/, ""),
        cfg.ollamaModel
      );
    case "voyage":
    default:
      if (!cfg.voyageApiKey) return null;
      return new VoyageEmbedder(
        cfg.voyageApiKey,
        cfg.voyageModel || "voyage-3.5-lite"
      );
  }
}

/**
 * Local embeddings via an Ollama server (http://localhost:11434). No key, no
 * rate limits, offline. Requires `ollama serve` and e.g. `ollama pull
 * nomic-embed-text`. nomic models want task prefixes, applied automatically.
 */
class OllamaEmbedder implements Embedder {
  readonly name = "Ollama";
  constructor(private baseUrl: string, private model: string) {}

  isConfigured(): boolean {
    return !!this.baseUrl && !!this.model;
  }

  private prefix(text: string, type: "document" | "query"): string {
    // nomic-embed-text is trained with these task prefixes.
    if (/nomic/i.test(this.model)) {
      return (type === "query" ? "search_query: " : "search_document: ") + text;
    }
    return text;
  }

  async embed(texts: string[], type: "document" | "query"): Promise<number[][]> {
    if (texts.length === 0) return [];
    const inputs = texts.map((t) => this.prefix(clip(t), type));
    // Chunk so a large paper doesn't overwhelm one /api/embed request (which can
    // partial/fail). Assert each batch returns as many vectors as it was sent.
    const CHUNK = 64;
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const batch = inputs.slice(i, i + CHUNK);
      const vecs = await this.embedBatch(batch);
      if (vecs.length !== batch.length) {
        throw new Error(
          `Ollama returned ${vecs.length}/${batch.length} embeddings for '${this.model}'.`
        );
      }
      out.push(...vecs);
    }
    return out;
  }

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    // Preferred: batch /api/embed (current Ollama).
    const batch = await requestUrl({
      url: `${this.baseUrl}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      throw: false,
      body: JSON.stringify({ model: this.model, input: inputs }),
    });
    if (batch.status === 200 && Array.isArray(batch.json?.embeddings)) {
      return batch.json.embeddings as number[][];
    }
    if (batch.status !== 404 && batch.status !== 400) {
      throw new Error(ollamaError(batch.status, batch.json, batch.text, this.model));
    }
    // Fall back to per-text /api/embeddings for older servers.
    const out: number[][] = [];
    for (const prompt of inputs) {
      const r = await requestUrl({
        url: `${this.baseUrl}/api/embeddings`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        throw: false,
        body: JSON.stringify({ model: this.model, prompt }),
      });
      if (r.status !== 200 || !Array.isArray(r.json?.embedding)) {
        throw new Error(ollamaError(r.status, r.json, r.text, this.model));
      }
      out.push(r.json.embedding as number[]);
    }
    return out;
  }
}

function ollamaError(status: number, json: any, text: string, model: string): string {
  const detail = (json && json.error) || text || "";
  if (status === 0 || status >= 500) {
    return `Ollama not reachable — run 'ollama serve' and 'ollama pull ${model}'. (${detail})`;
  }
  if (/not found|no such model/i.test(detail)) {
    return `Ollama model '${model}' not found — run 'ollama pull ${model}'.`;
  }
  return `Ollama embeddings failed (HTTP ${status}): ${detail}`;
}

class VoyageEmbedder implements Embedder {
  readonly name = "Voyage";
  constructor(private apiKey: string, private model: string) {}

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async embed(
    texts: string[],
    type: "document" | "query",
    onProgress?: (msg: string) => void
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Chunk by estimated tokens (~chars/4) so a request stays under Voyage's
    // restricted-tier 10K tokens/min limit; also cap the batch count.
    const MAX_TOKENS = 6000;
    const MAX_ITEMS = 96;
    let i = 0;
    let sent = 0;
    while (i < texts.length) {
      const batch: string[] = [];
      let tok = 0;
      while (i < texts.length && batch.length < MAX_ITEMS) {
        const t = clip(texts[i]);
        const est = Math.ceil(t.length / 4);
        if (batch.length > 0 && tok + est > MAX_TOKENS) break;
        batch.push(t);
        tok += est;
        i++;
      }
      if (texts.length > MAX_ITEMS) {
        onProgress?.(`embedding ${Math.min(i, texts.length)}/${texts.length}`);
      }
      const rows = await this.request(batch, type);
      rows.sort((a, b) => a.index - b.index);
      for (const r of rows) out.push(r.embedding);
      sent++;
    }
    void sent;
    return out;
  }

  private async request(
    batch: string[],
    type: "document" | "query"
  ): Promise<Array<{ embedding: number[]; index: number }>> {
    let wait = 20000; // restricted free tier is 3 req/min → back off ~20s
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await requestUrl({
        url: "https://api.voyageai.com/v1/embeddings",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        throw: false,
        body: JSON.stringify({ input: batch, model: this.model, input_type: type }),
      });
      if (res.status === 200) {
        return (res.json?.data ?? []) as Array<{ embedding: number[]; index: number }>;
      }
      if (res.status === 429 && attempt < 3) {
        await sleep(wait);
        wait = Math.min(wait + 10000, 45000);
        continue;
      }
      const detail = (res.json && (res.json.detail || res.json.error)) || res.text;
      throw new Error(`Voyage embeddings failed (HTTP ${res.status}): ${detail}`);
    }
    throw new Error("Voyage embeddings rate-limited; try again shortly.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Keep each input well under model token limits (~1 token ≈ 4 chars). */
function clip(s: string): string {
  const MAX = 8000;
  return s.length > MAX ? s.slice(0, MAX) : s;
}

/** Cosine similarity between two vectors (0 if either is empty/mismatched). */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
