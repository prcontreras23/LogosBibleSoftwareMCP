import { BIBLIA_API_KEY, BIBLIA_API_BASE, DEFAULT_BIBLE } from "../config.js";
import { toBibliaRef } from "./reference-parser.js";
import type { BibleTextResult, BibleSearchResult, BibleSearchHit, ScanResult, CompareResult, BibleInfo } from "../types.js";

const COMO_CONSEGUIR_CLAVE =
  "Para conseguir una clave gratuita: entra con tu cuenta de Faithlife (la misma de Logos) en " +
  "https://api.biblia.com/v1/Users/SignIn, crea una clave (dirección web: localhost) y colócala tú mismo " +
  "con ~/logos-para-claude/clave-biblia.sh (Mac) o volviendo a correr el instalador con -ClaveBiblia (Windows). " +
  "Mientras tanto, el texto se puede leer en tu Logos con navigate_passage o read_resource_at.";

/** Readable message for a failed Biblia response: no HTML blobs, and the fix when it is the key. */
export function bibliaErrorMessage(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `La API de Biblia rechazó la clave (error ${status}): la clave es inválida, se desactivó o no está aprobada. ${COMO_CONSEGUIR_CLAVE}`;
  }
  if (status === 404) {
    return "La API de Biblia no encontró ese pasaje o esa versión (error 404). Revisa la referencia o prueba otra versión con get_available_bibles.";
  }
  if (status === 429) {
    return "La API de Biblia está limitando las consultas (error 429). Espera un minuto y vuelve a intentarlo.";
  }
  // Keep only readable text: error bodies are often whole HTML pages.
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
  const plain = (title || body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 160);
  return `La API de Biblia respondió con error ${status}${plain ? `: ${plain}` : ""}.`;
}

async function bibliaFetch(path: string, params: Record<string, string>): Promise<unknown> {
  if (!BIBLIA_API_KEY) {
    throw new Error(`No hay clave de la API de Biblia (BIBLIA_API_KEY), así que las herramientas de texto bíblico por internet están apagadas; todo lo de Logos funciona igual. ${COMO_CONSEGUIR_CLAVE}`);
  }

  const url = new URL(`${BIBLIA_API_BASE}${path}`);
  url.searchParams.set("key", BIBLIA_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error("No hubo conexión con api.biblia.com (sin internet, o el servicio no respondió). El texto se puede leer en tu Logos con navigate_passage o read_resource_at.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(bibliaErrorMessage(res.status, body));
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

/** Real test call for diagnose: says whether the key works, without revealing it. */
export async function checkBibliaKey(): Promise<{ ok: boolean; message: string }> {
  if (!BIBLIA_API_KEY) return { ok: false, message: "no configurada (opcional: solo la usan las herramientas de texto bíblico por internet)" };
  try {
    await bibliaFetch("/content/LEB.txt", { passage: "John 3:16" });
    return { ok: true, message: "válida (consulta de prueba a Juan 3:16 respondida)" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function getBibleText(
  passage: string,
  bible: string = DEFAULT_BIBLE
): Promise<BibleTextResult> {
  // Biblia version codes are uppercase; accept any case from callers.
  bible = bible.toUpperCase();
  // Biblia only understands English book names; normalise Spanish names and
  // abbreviations through the reference parser, but pass anything it cannot
  // parse straight through so Biblia's own (more permissive) parser gets a go.
  const apiPassage = normalizeForBiblia(passage);
  const text = await bibliaFetch(`/content/${bible}.txt`, { passage: apiPassage });
  return {
    passage,
    text: String(text).trim(),
    bible,
  };
}

/** English-canonical passage for the Biblia API ("Romanos 8:28" → "Romans 8:28"). */
export function normalizeForBiblia(passage: string): string {
  try {
    return toBibliaRef(passage).replace(/\+/g, " ");
  } catch {
    return passage;
  }
}

// Biblia returns resultCount: -1 when the total is unknown; fall back to the
// number of results actually returned in that case.
export function normalizeResultCount(
  resultCount: number | null | undefined,
  resultsLength: number
): number {
  return resultCount != null && resultCount >= 0 ? resultCount : resultsLength;
}

export async function searchBible(
  query: string,
  options: { bible?: string; limit?: number; mode?: string } = {}
): Promise<BibleSearchResult> {
  const bible = (options.bible ?? DEFAULT_BIBLE).toUpperCase();
  const data = await bibliaFetch(`/search/${bible}`, {
    query,
    mode: options.mode ?? "verse",
    limit: String(options.limit ?? 20),
  }) as { resultCount: number; results: Array<{ title: string; preview: string }> };

  const results = data.results ?? [];
  return {
    query,
    resultCount: normalizeResultCount(data.resultCount, results.length),
    results: results.map((r): BibleSearchHit => ({
      title: r.title ?? "",
      preview: r.preview ?? "",
    })),
  };
}

export async function parsePassage(text: string): Promise<string> {
  const data = await bibliaFetch("/parse", { passage: text }) as { passage: string };
  return data.passage ?? text;
}

// ─── Scan References ────────────────────────────────────────────────────────

export async function scanReferences(
  text: string,
  tagChapters: boolean = true
): Promise<ScanResult[]> {
  const data = await bibliaFetch("/scan", {
    text,
    tagChapters: String(tagChapters),
  }) as { results: Array<{ passage: string; textIndex: number; textLength: number }> };

  return (data.results ?? []).map((r) => ({ passage: r.passage }));
}

// ─── Compare Passages ───────────────────────────────────────────────────────

export async function comparePassages(
  first: string,
  second: string
): Promise<CompareResult> {
  const data = await bibliaFetch("/compare", {
    first,
    second,
  }) as CompareResult;

  return {
    equal: data.equal ?? false,
    intersects: data.intersects ?? false,
    subset: data.subset ?? false,
    superset: data.superset ?? false,
    before: data.before ?? false,
    after: data.after ?? false,
  };
}

// ─── Get Available Bibles ───────────────────────────────────────────────────

export async function getAvailableBibles(
  query?: string
): Promise<BibleInfo[]> {
  const params: Record<string, string> = {};
  if (query) {
    params.query = query;
  }

  const data = await bibliaFetch("/find", params) as { bibles: BibleInfo[] };

  return data.bibles ?? [];
}
