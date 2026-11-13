import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { isIP } from "node:net";
import test from "node:test";

import { renderReport } from "../lib/report.mjs";
import { createResult } from "../lib/result.mjs";

const reportUrl = new URL("../REPORT.md", import.meta.url);
const botsUrl = new URL("../bots/", import.meta.url);

function leaks(text) {
  const home = text.match(/(?:\/home\/[^/\s`]+|\/Users\/[^/\s`]+|\/root)(?:\/[^\s`|]*)?/g) ?? [];
  const tokens = text.match(/\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{12,})/gi) ?? [];
  const candidates = text.match(/[0-9A-Fa-f:.]+/g) ?? [];
  return { home, ips: candidates.filter((candidate) => isIP(candidate) !== 0), tokens };
}

function reportNames(markdown) {
  const summary = markdown.split("## Summary\n\n")[1]?.split("\n\n")[0] ?? "";
  return summary.split("\n").slice(2).map((row) => row.split(" | ")[0].slice(2));
}

function unknownNames(markdown, labels) {
  return reportNames(markdown).filter((name) => !labels.has(name));
}

function statusRows(markdown) {
  return markdown.split("\n").filter((line) => line.startsWith("| status | "));
}

function makeMeta() {
  const result = createResult({ id: "sample", label: "Sample", command: "sample" });
  result.status = "skipped";
  return {
    results: [result],
    generatedAt: "2000-01-01 00:00:00 UTC",
    timeoutMs: 1000,
    prompt: "synthetic prompt",
    redactor: { text: (text) => text },
  };
}

test("report documentation and rendering", async (t) => {
  const originalEnv = process.env;
  process.env = {};
  t.after(() => { process.env = originalEnv; });

  const report = readFileSync(reportUrl, "utf8");
  await t.test("report contains no home paths, address literals, or token shapes", () => {
    assert.deepEqual(leaks(report), { home: [], ips: [], tokens: [] });
    const fakeHome = ["", "home", "synthetic"].join("/");
    const fakeV4 = ["192", "0", "2", "1"].join(".");
    const fakeV6 = ["2001", "db8", "", "1"].join(":");
    const fakeBearer = ["Bearer", "syntheticvalue"].join(" ");
    const fakeKey = ["sk", "syntheticvalue"].join("-");
    assert.deepEqual(leaks([fakeHome, fakeV4, fakeV6, fakeBearer, fakeKey].join(" ")), {
      home: [fakeHome], ips: [fakeV4, fakeV6], tokens: [fakeBearer, fakeKey],
    });
  });

  await t.test("every documented probe label belongs to a bot", () => {
    const labels = new Set(readdirSync(botsUrl).filter((name) => name.endsWith(".mjs")).map((name) => {
      const source = readFileSync(new URL(name, botsUrl), "utf8");
      const match = source.match(/export const probe = \{\s*id: "[^"]+",\s*label: "([^"]+)"/);
      assert.notEqual(match, null, `missing probe label in ${name}`);
      return match[1];
    }));
    assert.equal(reportNames(report).length, labels.size);
    assert.deepEqual(unknownNames(report, labels), []);
    const headings = [...report.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(headings, reportNames(report));
    const altered = report.replace(/\| Codex \|/, "| SyntheticUnknown |");
    assert.deepEqual(unknownNames(altered, labels), ["SyntheticUnknown"]);
  });

  await t.test("skipped status is rendered as the exact status value", () => {
    const markdown = renderReport(makeMeta());
    assert.deepEqual(statusRows(markdown), ["| status | skipped |"]);
    assert.deepEqual(statusRows(markdown.replace("| status | skipped |", "| status | failed |")), ["| status | failed |"]);
  });

  await t.test("rendering identical metadata is deterministic", () => {
    const meta = makeMeta();
    const first = renderReport(meta);
    assert.equal(renderReport(meta), first);
    const altered = { ...meta, prompt: "different synthetic prompt" };
    assert.notEqual(renderReport(altered), first);
  });
});
