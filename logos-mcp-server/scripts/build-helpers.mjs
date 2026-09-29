#!/usr/bin/env node
// Builds the two native helpers as universal (arm64 + x86_64) binaries into
// helpers/, so users never need a working compiler. Run on a Mac with a sane
// toolchain after `npm run build`:
//
//   node scripts/build-helpers.mjs
//
// The sources are the same strings the server would compile at runtime.

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "helpers");
const { SWIFT_SOURCE } = await import(join(root, "dist/services/panel-text.js"));
const { OBJ_C_SOURCE } = await import(join(root, "dist/services/screenshot-capture.js"));

const MIN = "11.0";
const tmp = mkdtempSync(join(tmpdir(), "logos-helpers-"));
mkdirSync(out, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

try {
  // Swift drag helper: one slice per architecture, then lipo.
  const swiftSrc = join(tmp, "logos-drag-helper.swift");
  writeFileSync(swiftSrc, SWIFT_SOURCE);
  const slices = [];
  for (const arch of ["arm64", "x86_64"]) {
    const slice = join(tmp, `drag-${arch}`);
    run("swiftc", ["-O", "-target", `${arch}-apple-macos${MIN}`, "-o", slice, swiftSrc]);
    slices.push(slice);
  }
  run("lipo", ["-create", "-output", join(out, "logos-drag-helper"), ...slices]);

  // Objective-C window helper: clang builds both slices in one go.
  const objcSrc = join(tmp, "logos-window-helper.m");
  writeFileSync(objcSrc, OBJ_C_SOURCE);
  run("clang", [
    "-arch", "arm64", "-arch", "x86_64", `-mmacosx-version-min=${MIN}`, "-O2",
    "-framework", "CoreGraphics", "-framework", "Foundation",
    "-o", join(out, "logos-window-helper"), objcSrc,
  ]);

  // lipo drops the linker's ad-hoc signature; Apple Silicon refuses to run
  // unsigned code, so sign the fat binaries ad hoc again.
  for (const f of ["logos-drag-helper", "logos-window-helper"]) {
    run("codesign", ["--force", "--sign", "-", join(out, f)]);
    run("lipo", ["-info", join(out, f)]);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
