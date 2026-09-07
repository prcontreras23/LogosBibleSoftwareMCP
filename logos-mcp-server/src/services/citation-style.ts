import Database from "better-sqlite3";
import { existsSync } from "fs";
import { DB_PATHS } from "../config.js";

/**
 * Logos stores the citation style the user picked in Settings → Citation Style
 * as a preference row, e.g. `LogosDesktop/CurrentCitationFormat` →
 * `"turabian-author-date"`. Reading it lets the MCP render citations the way
 * the user already configured Logos, instead of dumping raw fields.
 */
export function getCitationStyle(): string | null {
  const path = DB_PATHS.preferences;
  if (!existsSync(path)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT Prefs FROM Preferences WHERE SyncId = ? AND IsDeleted = 0")
      .get("LogosDesktop/CurrentCitationFormat") as { Prefs?: string } | undefined;
    if (!row?.Prefs) return null;
    // Stored JSON-quoted: "turabian-author-date"
    return row.Prefs.trim().replace(/^"|"$/g, "") || null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Styles that put the year right after the author, e.g. (Thiselton 2000, 62–63). */
const AUTHOR_DATE = /author-date|apa|harvard/i;

export interface FormattedCitation {
  /** The style id Logos reports, e.g. "turabian-author-date". */
  style: string | null;
  /** Full reference rendered in that style. */
  full: string;
  /** Short in-text form; only for author-date styles. */
  short?: string;
}

/**
 * Render the `%T/%A/%D/...` fields Logos appends on copy into the user's
 * configured style. Falls back to the plain field list when the style is
 * unknown or the fields are too sparse to shape a reference.
 */
export function formatCitation(
  fields: Record<string, string>,
  style: string | null
): FormattedCitation | null {
  const { author, editor, title, city, publisher, year, pages, volume } = fields;
  if (!title && !author && !editor) return null;

  const who = author ?? (editor ? `${editor}, ed.` : "");
  /** Add a period unless the text already ends in one (e.g. "Anthony C." or "ed."). */
  const dot = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
  const vol = volume ? `, vol. ${volume}` : "";
  const place = [city, publisher].filter(Boolean).join(": ");
  const pp = pages ? `${/[–-]/.test(pages) ? "" : "p. "}${pages}` : "";

  if (style && AUTHOR_DATE.test(style)) {
    // Turabian 9 / Chicago author-date:
    //   Thiselton, Anthony C. 2000. Title. City: Publisher. 62–63.
    const full = [
      who && dot(who),
      year && `${year}.`,
      title && dot(`${title}${vol}`),
      place && dot(place),
      pp && dot(pp),
    ]
      .filter(Boolean)
      .join(" ");
    const lastName = who.split(",")[0]?.trim();
    const short =
      lastName && year ? `(${lastName} ${year}${pages ? `, ${pages}` : ""})` : undefined;
    return { style, full, short };
  }

  // Notes-bibliography shape (Turabian/Chicago notes, SBL, MLA and friends):
  //   Anthony C. Thiselton, Title (Grand Rapids: Eerdmans, 2000), 62–63.
  const paren = [place, year].filter(Boolean).join(", ");
  const full = [
    who && `${who},`,
    title && `${title}${vol}`,
    paren && `(${paren})`,
    pages && `${pages}`,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+\(/, " (")
    .replace(/\)\s+/, "), ")
    .concat(".");
  return { style, full };
}
