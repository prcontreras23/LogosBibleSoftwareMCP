/**
 * health.ts
 *
 * Checks that go beyond "the file exists": they actually exercise each piece
 * (a real Biblia call, the native helpers, the macOS permissions, Logos
 * itself) and say in Spanish what is wrong and how to fix it. Shared by the
 * `diagnose` tool and the `logos-mcp-diagnose` CLI the installer runs.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { checkBibliaKey } from "./biblia-api.js";
import { isLogosRunning } from "./logos-app.js";
import { ensureHelper, describeLogosWindows } from "./screenshot-capture.js";
import { ensureDragHelper } from "./panel-text.js";

const execFileAsync = promisify(execFile);

export interface HealthCheck {
  name: string;
  /** true = works, false = broken, null = could not be checked right now */
  ok: boolean | null;
  message: string;
}

export async function runHealthChecks(): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const mac = process.platform === "darwin";

  const clave = await checkBibliaKey();
  checks.push({ name: "Clave de la API de Biblia", ok: clave.message.startsWith("no configurada") ? null : clave.ok, message: clave.message });

  const running = await isLogosRunning().catch(() => false);
  checks.push({
    name: "Logos abierto",
    ok: running ? true : null,
    message: running ? "sí" : "no está abierto; ábrelo antes de pedir lecturas, capturas o navegación",
  });

  if (!mac) {
    checks.push({ name: "Lectura de paneles y capturas", ok: null, message: "solo en Mac; en Windows no están disponibles" });
    return checks;
  }

  for (const [name, ensure] of [
    ["Ayudante de ventanas", ensureHelper],
    ["Ayudante de lectura (arrastre)", ensureDragHelper],
  ] as const) {
    try {
      await ensure();
      checks.push({ name, ok: true, message: "listo" });
    } catch (e) {
      checks.push({ name, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // Accessibility is granted to the app that launched the server (Terminal,
  // iTerm, Claude…), and System Events reports whether that app is trusted.
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", 'tell application "System Events" to get UI elements enabled']);
    const on = stdout.trim() === "true";
    checks.push({
      name: "Permiso de Accesibilidad",
      ok: on,
      message: on
        ? "concedido"
        : "falta: Ajustes del Sistema → Privacidad y seguridad → Accesibilidad, activar la app desde la que corre Claude, y reabrirla",
    });
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? String(e);
    checks.push({
      name: "Permiso de Accesibilidad",
      ok: false,
      message: /-1743|not authorized/i.test(msg)
        ? "macOS no deja controlar System Events: Ajustes del Sistema → Privacidad y seguridad → Automatización, activar System Events para la app desde la que corre Claude"
        : `no se pudo comprobar: ${msg.split("\n")[0]}`,
    });
  }

  if (running) {
    const w = await describeLogosWindows();
    const falta = w.problem?.includes("Grabación de pantalla") ?? false;
    checks.push({
      name: "Permiso de Grabación de pantalla",
      ok: w.titles.length > 0 ? true : falta ? false : null,
      message: w.titles.length > 0 ? `concedido (se leen ${w.titles.length} título(s) de ventana)` : (w.problem ?? "sin datos"),
    });
  } else {
    checks.push({ name: "Permiso de Grabación de pantalla", ok: null, message: "abre Logos para comprobarlo" });
  }

  return checks;
}

export function formatHealthChecks(checks: HealthCheck[]): string[] {
  return checks.map((c) => {
    const mark = c.ok === true ? "[ok]" : c.ok === false ? "[falla]" : "[--]";
    return `  ${mark} ${c.name}: ${c.message}`;
  });
}
