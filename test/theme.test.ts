/**
 * Appearance.
 *
 * The page has three appearance states and the default is the absence of a
 * choice: no stored value, no `data-theme` attribute, and the operating system
 * decides. That default is the property most worth pinning, because the easy
 * mistake is to ship a preference nobody asked for.
 *
 * These assert the served CSS and script rather than a rendered page. The
 * cascade rules are the contract here, and a headless DOM would only prove that
 * jsdom implements them.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "web", "styles.css"), "utf8");
const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
const script = readFileSync(join(ROOT, "web", "app.js"), "utf8");

/** The token block a selector opens, up to its closing brace. */
function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

describe("three appearances, defaulting to none", () => {
  it("offers exactly system, light and dark", () => {
    for (const id of ["theme-system", "theme-light", "theme-dark"]) {
      expect(html).toContain(`id="${id}"`);
    }
    // No fourth theme crept in.
    expect(css.match(/\[data-theme="[a-z]+"\]/g)?.every((m) => /"(light|dark)"/.test(m))).toBe(true);
  });

  it("defaults to system: nothing stored, no attribute, no forced appearance", () => {
    expect(html).toContain('id="theme-system" aria-pressed="true"');
    expect(html).toContain('id="theme-light" aria-pressed="false"');
    expect(html).toContain('id="theme-dark" aria-pressed="false"');
    // The served markup carries no data-theme; only the reader's own choice adds one.
    expect(html).not.toMatch(/<html[^>]*data-theme/);
    expect(script).toContain('if (theme === "system") document.documentElement.removeAttribute("data-theme")');
    expect(script).toContain('if (theme === "system") localStorage.removeItem(THEME_KEY)');
  });

  it("follows a system dark preference when no choice was made", () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    const dark = block('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])');
    expect(dark).toContain("--paper: #0b0d14");
    expect(dark).toContain("--ink: #eef0f6");
  });

  it("lets an explicit light choice override a system dark preference", () => {
    // The media query is guarded, so [data-theme="light"] is simply not matched
    // by it and the base :root values stand.
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(block(":root {")).toContain("--paper: #fbfbfd");
  });

  it("lets an explicit dark choice override a system light preference", () => {
    const dark = block(':root[data-theme="dark"]');
    expect(dark).toContain("--paper: #0b0d14");
    expect(dark).toContain("--ink: #eef0f6");
  });

  it("persists an explicit choice and forgets it when system is chosen again", () => {
    expect(script).toContain('localStorage.setItem(THEME_KEY, theme)');
    expect(script).toContain('localStorage.removeItem(THEME_KEY)');
    expect(script).toContain('const stored = localStorage.getItem(THEME_KEY)');
  });

  it("applies a stored choice before first paint, ahead of the stylesheet", () => {
    const inline = html.indexOf('localStorage.getItem("x402seek-theme")');
    const sheet = html.indexOf('href="/styles.css"');
    expect(inline).toBeGreaterThan(-1);
    expect(inline).toBeLessThan(sheet);
    // A blocked or failed read must not break the page.
    expect(html).toContain("catch (e)");
  });
});

describe("the palette keeps its meanings in both appearances", () => {
  it("defines every colour as a token, so dark is a value list and not a second stylesheet", () => {
    const body = css.slice(css.indexOf("* { box-sizing: border-box; }"));
    expect(body.match(/#[0-9a-fA-F]{3,6}|rgba\(/g)).toBeNull();
  });

  it("keeps indigo for x402Seek, green for live and red for abstention", () => {
    for (const scope of [":root {", ':root[data-theme="dark"]']) {
      const tokens = block(scope);
      for (const token of ["--accent:", "--ok:", "--rose:", "--amber:", "--on-accent:"]) {
        expect(tokens, `${scope} ${token}`).toContain(token);
      }
    }
    // Live mode still reaches for the same token it did before.
    expect(css).toContain("body.live-mode #go { background: var(--ok); }");
    expect(css).toContain("body.live-mode .mode-badge { color: var(--ok); }");
  });
});

describe("appearance is only appearance", () => {
  it("never touches the data source, the query or the mode", () => {
    const theme = script.slice(script.indexOf("const THEME_KEY"), script.indexOf("/* ---------- wire up"));
    for (const forbidden of ["MODE", "setMode", "fetch(", "/api/", "search("]) {
      expect(theme, forbidden).not.toContain(forbidden);
    }
  });

  it("adds no payment surface", async () => {
    const app = buildServer();
    const surface = `${html}\n${script}`.toLowerCase();
    for (const banned of ["connect wallet", "pay now", "private key", "seed phrase", "faucet"]) {
      expect(surface, banned).not.toContain(banned);
    }
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes.match(/\((POST|PUT|PATCH|DELETE)\)/g) ?? []).toEqual(["(POST)"]);
    await app.close();
  });

  it("labels the control for people who cannot see the icons", () => {
    expect(html).toContain('role="group" aria-label="Appearance"');
    expect(html).toContain("Match system appearance");
    expect(html).toContain("Light appearance");
    expect(html).toContain("Dark appearance");
    // aria-pressed is kept in step with the visual state.
    expect(script).toContain('button.setAttribute("aria-pressed", String(name === theme))');
    expect(css).toContain(".tbtn:focus-visible");
  });
});
