import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { compilerMessage, HelperUnavailableError, bundledHelperPath } from "../src/services/helpers.js";

describe("native helpers", () => {
  it("ships both prebuilt helpers", () => {
    expect(existsSync(bundledHelperPath("logos-drag-helper"))).toBe(true);
    expect(existsSync(bundledHelperPath("logos-window-helper"))).toBe(true);
  });

  it("picks the meaningful compiler line (SDK/compiler mismatch)", () => {
    const e = Object.assign(new Error("Command failed: swiftc"), {
      stderr: "note: something\n<unknown>:0: error: this SDK is not supported by the compiler\nerror: redefinition of module 'SwiftBridging'",
    });
    expect(compilerMessage(e)).toContain("this SDK is not supported by the compiler");
  });

  it("gives the fix in Spanish and says the other tools keep working", () => {
    const msg = new HelperUnavailableError("logos-drag-helper", new Error("boom")).message;
    expect(msg).toContain("xcode-select --install");
    expect(msg).toContain("siguen funcionando");
  });
});
