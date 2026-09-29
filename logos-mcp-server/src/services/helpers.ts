/**
 * helpers.ts
 *
 * The screen tools need two tiny native helpers (a CGWindowList lister in
 * Objective-C and a CGEvent drag in Swift). Compiling them on the user's Mac
 * is fragile: a Command Line Tools install whose compiler and SDK are out of
 * sync fails with "this SDK is not supported by the compiler". So the package
 * ships universal (arm64 + x86_64) prebuilt binaries in `helpers/`, built by
 * `scripts/build-helpers.mjs`, and compiling locally is only the fallback.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { HELPER_CACHE_DIR } from "../config.js";

/** Where the prebuilt helpers live inside the package (…/logos-mcp-server/helpers). */
export function bundledHelperPath(name: string): string {
  return fileURLToPath(new URL(`../../helpers/${name}`, import.meta.url));
}

export class HelperUnavailableError extends Error {
  constructor(public readonly helper: string, cause: unknown) {
    const detail = compilerMessage(cause);
    super(
      `No se pudo preparar el ayudante «${helper}», que hace falta para leer paneles y tomar capturas de Logos. ` +
        `Las demás herramientas (catálogo, notas, sermones, planes, navegación) siguen funcionando.\n` +
        (detail ? `Error del compilador: ${detail}\n` : "") +
        `Arreglo: reinstalar las Command Line Tools de Apple. En la Terminal:\n` +
        `  sudo rm -rf /Library/Developer/CommandLineTools\n` +
        `  xcode-select --install\n` +
        `y después volver a correr el instalador de Logos para Claude.`
    );
    this.name = "HelperUnavailableError";
  }
}

/** First meaningful line of a compiler failure, for the user-facing message. */
export function compilerMessage(cause: unknown): string {
  const raw =
    (cause as { stderr?: string })?.stderr ||
    (cause instanceof Error ? cause.message : String(cause ?? ""));
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /error:|not supported|redefinition|not found|ENOENT/i.test(l));
  return (line ?? raw.split("\n")[0] ?? "").slice(0, 300);
}

/**
 * Make sure `bin` exists: copy the bundled prebuilt binary if there is one,
 * otherwise write `source` next to it and run `compile`. Throws
 * HelperUnavailableError (in Spanish, with the fix) when neither works.
 */
export async function ensureNativeHelper(opts: {
  name: string;
  bin: string;
  src: string;
  source: string;
  compile: () => Promise<unknown>;
}): Promise<void> {
  if (existsSync(opts.bin)) return;
  mkdirSync(HELPER_CACHE_DIR, { recursive: true, mode: 0o700 });
  const bundled = bundledHelperPath(opts.name);
  if (existsSync(bundled)) {
    copyFileSync(bundled, opts.bin);
    chmodSync(opts.bin, 0o755);
    return;
  }
  writeFileSync(opts.src, opts.source);
  try {
    await opts.compile();
  } catch (e) {
    throw new HelperUnavailableError(opts.name, e);
  }
}

/** Status of one helper, for diagnose: ready, can be copied, or needs a compiler. */
export function helperStatus(name: string, bin: string): "listo" | "incluido" | "falta" {
  if (existsSync(bin)) return "listo";
  if (existsSync(bundledHelperPath(name))) return "incluido";
  return "falta";
}
