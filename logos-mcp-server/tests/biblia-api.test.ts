import { describe, it, expect } from "vitest";
import { normalizeResultCount, bibliaErrorMessage } from "../src/services/biblia-api.js";

describe("normalizeResultCount", () => {
  it("uses the reported count when it is a non-negative number", () => {
    expect(normalizeResultCount(42, 5)).toBe(42);
    expect(normalizeResultCount(0, 5)).toBe(0);
  });

  it("falls back to the result length when Biblia reports -1 (unknown total)", () => {
    expect(normalizeResultCount(-1, 5)).toBe(5);
  });

  it("falls back to the result length for null/undefined", () => {
    expect(normalizeResultCount(null, 3)).toBe(3);
    expect(normalizeResultCount(undefined, 3)).toBe(3);
  });
});

describe("normalizeForBiblia", () => {
  it("translates Spanish references to English for the API", async () => {
    const { normalizeForBiblia } = await import("../src/services/biblia-api.js");
    expect(normalizeForBiblia("Romanos 8:28")).toBe("Romans 8:28");
    expect(normalizeForBiblia("1 Co 1:4-9")).toBe("1 Corinthians 1:4-9");
  });
  it("passes through what the parser cannot handle", async () => {
    const { normalizeForBiblia } = await import("../src/services/biblia-api.js");
    expect(normalizeForBiblia("Gen 1:1; Exod 2:1")).toBe("Gen 1:1; Exod 2:1");
  });
});

describe("bibliaErrorMessage", () => {
  it("explains a rejected key and how to get one, without HTML", () => {
    const msg = bibliaErrorMessage(403, "<html><head><title>403 Forbidden</title></head><body>…</body></html>");
    expect(msg).toContain("rechazó la clave");
    expect(msg).toContain("api.biblia.com/v1/Users/SignIn");
    expect(msg).not.toContain("<");
  });

  it("reduces an unknown HTML error page to its title", () => {
    const msg = bibliaErrorMessage(500, "<html><head><title>Server Error</title></head><body>" + "x".repeat(5000) + "</body></html>");
    expect(msg).toBe("La API de Biblia respondió con error 500: Server Error.");
  });
});
