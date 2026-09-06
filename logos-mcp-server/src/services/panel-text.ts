/**
 * panel-text.ts
 *
 * Reads the text of the resource panel currently shown in Logos by
 * drag-selecting it with synthetic mouse events (CGEvent, via a small
 * compiled Swift helper), copying with Cmd+C and reading the clipboard.
 *
 * Why this approach: Logos resource files (.logos4, LRES01) are encrypted,
 * the reader panel is CEF-based (empty accessibility tree) and it has no
 * "Select All". Drag-selection + copy is the only text path that works, and
 * Logos appends its own citation block (%T/%C/%I/%E/%D/%P) to the copy,
 * which we return as structured metadata.
 *
 * macOS only. Requires Accessibility permission for the host process.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { HELPER_CACHE_DIR } from "../config.js";
import { getLogosWindows } from "./screenshot-capture.js";
import type { LogosWindow } from "../types.js";

const execFileAsync = promisify(execFile);

const DRAG_HELPER_BIN = join(HELPER_CACHE_DIR, "logos-drag-helper");
const DRAG_HELPER_SRC = join(HELPER_CACHE_DIR, "logos-drag-helper.swift");

// Region of the window that holds the reading text. Measured on Logos v48
// with the standard panel chrome (tab bar + toolbar + locator bar ≈ 160 px).
const TEXT_TOP_OFFSET = 165;
const TEXT_LEFT_OFFSET = 20;
const TEXT_RIGHT_OFFSET = 40; // leaves the scrollbar out of the selection
const TEXT_BOTTOM_OFFSET = 10;
// A real screen of text is hundreds of chars; anything shorter means the
// drag selected a stray word (e.g. it became a drag-and-drop) — retry.
const MIN_BODY_CHARS = 40;

const SWIFT_SOURCE = `
import Foundation
import CoreGraphics
let a = CommandLine.arguments.dropFirst().map { Double($0)! }
let p1 = CGPoint(x: a[0], y: a[1]), p2 = CGPoint(x: a[2], y: a[3])
func ev(_ t: CGEventType, _ p: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
}
ev(.mouseMoved, p1); usleep(150000)
ev(.leftMouseDown, p1); usleep(150000)
let steps = 25
for i in 1...steps {
  let t = Double(i)/Double(steps)
  ev(.leftMouseDragged, CGPoint(x: p1.x + (p2.x-p1.x)*t, y: p1.y + (p2.y-p1.y)*t)); usleep(20000)
}
usleep(150000); ev(.leftMouseUp, p2)
`;

export interface PanelTextResult {
  text: string;
  citation: Record<string, string>;
  pages: number;
  window: string;
}

async function ensureDragHelper(): Promise<void> {
  if (existsSync(DRAG_HELPER_BIN)) return;
  mkdirSync(HELPER_CACHE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DRAG_HELPER_SRC, SWIFT_SOURCE);
  await execFileAsync("swiftc", ["-O", "-o", DRAG_HELPER_BIN, DRAG_HELPER_SRC]);
}

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  return stdout.trim();
}

async function readClipboard(): Promise<string> {
  const { stdout } = await execFileAsync("pbpaste", [], {
    env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function clearClipboard(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("pbcopy", [], (e) => (e ? reject(e) : resolve()));
    child.stdin?.end("");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Join consecutive screens, dropping the text a Page Down leaves visible from
 * the previous screen. Finds the longest suffix of `acc` (≥ minOverlap chars)
 * that is a prefix of `next`, comparing on whitespace-normalised text.
 */
export function mergeOverlap(acc: string, next: string, minOverlap = 40): string {
  if (!acc) return next;
  if (!next) return acc;
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const a = norm(acc);
  const b = norm(next);
  const max = Math.min(a.length, b.length);
  for (let len = max; len >= minOverlap; len--) {
    if (a.endsWith(b.slice(0, len))) {
      // Map the normalised cut back onto `next`: skip the same number of
      // non-whitespace characters.
      let nonWs = b.slice(0, len).replace(/ /g, "").length;
      let i = 0;
      while (i < next.length && nonWs > 0) {
        if (!/\s/.test(next[i])) nonWs--;
        i++;
      }
      return `${acc.trimEnd()}\n${next.slice(i).trimStart()}`;
    }
  }
  return `${acc}\n\n${next}`;
}

/** Split the Logos copy into body text and its trailing %X citation lines. */
export function splitCitation(raw: string): { body: string; citation: Record<string, string> } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const citation: Record<string, string> = {};
  const keyNames: Record<string, string> = {
    T: "title", C: "city", I: "publisher", E: "editor", A: "author", D: "year", P: "pages", V: "volume",
  };
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^%([A-Z])\s+(.*)$/);
    if (m) {
      citation[keyNames[m[1]] ?? m[1]] = m[2].trim();
      end = i;
    } else if (lines[i].trim() === "") {
      end = i;
    } else {
      break;
    }
  }
  return { body: lines.slice(0, end).join("\n").trim(), citation };
}

export type PanelSelector = "left" | "right" | "largest" | number;

interface Rect { x: number; y: number; width: number; height: number; name: string }

/**
 * Locate the reading panel to select. CGWindowList exposes Logos' internal
 * panel windows (layer 0, unnamed) alongside the main app window (named
 * "Logos…"). Panel widths/x are reliable; their reported heights are not
 * (CEF sub-windows), so the bottom edge is taken from the main window.
 */
async function pickPanel(selector: PanelSelector): Promise<Rect | null> {
  const windows = await getLogosWindows();
  const main = windows
    .filter((w) => w.layer === 0 && w.name && w.name.includes("Logos"))
    .reduce<LogosWindow | null>((b, w) => (!b || w.width * w.height > b.width * b.height ? w : b), null);
  if (!main) return null;
  const mainBottom = main.y + main.height;

  const candidates = windows
    .filter((w) => w.layer === 0 && !w.name && w.width >= 300 && w.height >= 200)
    .filter((w) => w.x >= main.x && w.x + w.width <= main.x + main.width + 2 && w.width < main.width - 40);
  // Logos also keeps phantom CEF windows (e.g. a 500×500 one at the corner)
  // that overlap the real panels; real panels tile without overlapping, so
  // drop any candidate that overlaps a larger candidate.
  const overlaps = (a: LogosWindow, b: LogosWindow) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const panels = candidates
    .filter((w) => !candidates.some((o) => o !== w && o.width * o.height > w.width * w.height && overlaps(w, o)))
    .sort((a, b) => a.x - b.x);

  let chosen: LogosWindow | undefined;
  if (panels.length === 0) {
    chosen = main; // single-panel layout: fall back to the whole window
  } else if (selector === "left") chosen = panels[0];
  else if (selector === "right") chosen = panels[panels.length - 1];
  else if (typeof selector === "number") chosen = panels[Math.min(Math.max(selector, 1), panels.length) - 1];
  else chosen = panels.reduce((b, w) => (w.width * w.height > b.width * b.height ? w : b));

  return { x: chosen.x, y: chosen.y, width: chosen.width, height: mainBottom - chosen.y, name: main.name };
}

/**
 * Drag-select the visible text of the Logos panel and copy it. With
 * `pages > 1`, presses Page Down between copies and concatenates the
 * results (overlaps at page boundaries are not deduplicated).
 */
export async function readPanelText(pages = 1, panel: PanelSelector = "largest"): Promise<PanelTextResult> {
  if (process.platform !== "darwin") {
    throw new Error("read_panel_text is macOS-only (uses CGEvent + pbpaste).");
  }
  await ensureDragHelper();

  const win = await pickPanel(panel);
  if (!win) throw new Error("No Logos window found. Is Logos running and visible?");

  const previousClipboard = await readClipboard().catch(() => "");
  await osascript('tell application "Logos" to activate');
  await sleep(800);

  const x1 = win.x + TEXT_LEFT_OFFSET;
  const y1 = win.y + TEXT_TOP_OFFSET;
  const x2 = win.x + win.width - TEXT_RIGHT_OFFSET;
  const y2 = win.y + win.height - TEXT_BOTTOM_OFFSET;

  const chunks: string[] = [];
  let citation: Record<string, string> = {};

  for (let p = 0; p < pages; p++) {
    if (p > 0) {
      // The previous drag left keyboard focus on this panel; scroll one screen.
      await osascript('tell application "System Events" to key code 121'); // Page Down
      await sleep(1500);
    }
    // Logos keeps the selection after Cmd+C, and neither a click nor Escape
    // clears it. A drag that starts on selected text becomes a drag-and-drop:
    // it copies nothing but does clear the selection, so the next drag works.
    // Hence: drag, copy, and retry when the result is empty or a stray word.
    let raw = "";
    let body = "";
    let pageCitation: Record<string, string> = {};
    for (let attempt = 0; attempt < 3 && body.length < MIN_BODY_CHARS; attempt++) {
      await clearClipboard();
      await execFileAsync(DRAG_HELPER_BIN, [String(x1), String(y1), String(x2), String(y2)]);
      await sleep(500);
      await osascript('tell application "System Events" to keystroke "c" using command down');
      await sleep(1200);
      raw = await readClipboard();
      ({ body, citation: pageCitation } = splitCitation(raw));
      if (process.env.LOGOS_DEBUG) console.error(`[read_panel_text] page ${p + 1} attempt ${attempt + 1}: raw=${raw.length} body=${body.length} drag=(${x1},${y1})→(${x2},${y2})`);
    }
    if (body.length < MIN_BODY_CHARS) {
      if (p === 0) {
        throw new Error(
          "Clipboard came back empty after drag-select + Cmd+C (3 attempts). Check that (1) the Logos window is not covered by another window, (2) the host app has Accessibility permission (System Settings → Privacy & Security → Accessibility), and (3) a resource panel with text is open."
        );
      }
      break;
    }
    if (Object.keys(pageCitation).length > 0) citation = pageCitation;
    chunks.push(body);
  }

  // Clear the selection (a short drag-and-drop on the selected text) so a
  // later call — or the user — starts from a clean panel; then restore the
  // user's clipboard.
  // (A short drag is taken as a click and leaves the selection in place, so
  // drag across a good stretch of the selected area.)
  const cx = Math.round((x1 + x2) / 2);
  const cy = Math.round((y1 + y2) / 2);
  await execFileAsync(DRAG_HELPER_BIN, [String(cx), String(cy), String(x2 - 20), String(y2 - 20)]).catch(() => {});
  if (previousClipboard) {
    await new Promise<void>((resolve) => {
      const child = execFile("pbcopy", [], { env: { ...process.env, LANG: "en_US.UTF-8" } }, () => resolve());
      child.stdin?.end(previousClipboard);
    });
  }

  const text = chunks.reduce((acc, c) => mergeOverlap(acc, c), "");
  return { text, citation, pages: chunks.length, window: win.name };
}
