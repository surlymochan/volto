// probes/lib/report.mjs
//
// Renders probes/REPORT.md from the probe results.

/**
 * @param {string} value
 */
function cell(value) {
  if (value === null || value === undefined) return "-";
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * @param {boolean|null} value
 * @param {string} yes
 * @param {string} no
 */
function yesNo(value, yes = "yes", no = "no") {
  if (value === true) return yes;
  if (value === false) return no;
  return "unknown";
}

/**
 * @param {number|null} value
 */
function ms(value) {
  return value === null || value === undefined ? "-" : `${value} ms`;
}

/**
 * @param {import("./result.mjs").ProbeResult} result
 * @returns {string[]}
 */
function summaryRow(result) {
  const p = result.protocol;
  return [
    result.label,
    `${result.status}${result.reason ? ` (${result.reason})` : ""}`,
    `${p.name} (${p.transport}, ${p.framing})`,
    `${yesNo(p.sessionCreate.supported)} - ${p.sessionCreate.method || "n/a"}`,
    p.streaming.granularity,
    yesNo(p.cancel.works),
    `${yesNo(p.resume.supported)} - ${p.resume.method || "n/a"}`,
    p.permissions.shape,
    result.auth.state,
  ];
}

/**
 * @param {import("./result.mjs").ProbeResult} result
 * @returns {string[]}
 */
function detailRows(result) {
  const p = result.protocol;
  return [
    ["status", result.status + (result.reason ? ` (${result.reason})` : "")],
    ["binary", `${result.binary.command}${result.binary.version ? ` ${result.binary.version}` : ""}`],
    ["protocol", `${p.name} - ${p.transport}, ${p.framing}`],
    [
      "session create",
      `${yesNo(p.sessionCreate.supported)} - ${p.sessionCreate.method || "n/a"}: ${p.sessionCreate.detail || "-"}`,
    ],
    [
      "streaming granularity",
      `${p.streaming.granularity}${p.streaming.samples ? ` (${p.streaming.samples} samples)` : ""}: ${p.streaming.detail || "-"}`,
    ],
    ["cancel works?", `${yesNo(p.cancel.works)} - ${p.cancel.method || "n/a"}: ${p.cancel.detail || "-"}`],
    [
      "resume / load support",
      `${yesNo(p.resume.supported)} - ${p.resume.method || "n/a"}: ${p.resume.detail || "-"}`,
    ],
    ["permission request shape", `${p.permissions.shape}${p.permissions.observed?.length ? ` (observed: ${p.permissions.observed.join(", ")})` : ""}`],
    ["auth state", `${result.auth.state}: ${result.auth.evidence || "-"}`],
    [
      "timings",
      `initialize ${ms(result.timings.initializeMs)}, session ${ms(result.timings.sessionCreateMs)}, first output ${ms(result.timings.firstOutputMs)}, prompt ${ms(result.timings.promptMs)}, cancel ${ms(result.timings.cancelMs)}, total ${ms(result.timings.totalMs)}`,
    ],
    [
      "methods",
      `${result.methods.requests.length} client requests, ${result.methods.notifications.length} notifications, ${result.methods.serverRequests.length} server requests`,
    ],
    ["transcript", result.transcript ? `\`${result.transcript}\`` : "-"],
  ];
}

/**
 * @param {{
 *   results: import("./result.mjs").ProbeResult[],
 *   generatedAt: string,
 *   timeoutMs: number,
 *   prompt: string,
 *   redactor: { text: (s: string) => string },
 * }} meta
 */
export function renderReport(meta) {
  const lines = [];
  const push = (...items) => lines.push(...items);

  push("# volto - bot protocol probes", "");
  push(
    `Generated ${meta.generatedAt} - hard timeout ${Math.round(meta.timeoutMs / 1000)} s per bot - probe prompt: "${meta.prompt}" (no tools).`,
    "",
  );
  push(
    "Every probe starts the bot in its machine protocol, creates a session, sends one trivial prompt, cancels a second prompt and closes the process.",
    "Transcripts are redacted (no tokens, host names or IP addresses) and live under `probes/out/`, which is git-ignored.",
    "",
  );

  const skipped = meta.results.filter((result) => result.status !== "ok");
  if (skipped.length) {
    push(
      `Skipped on this host: ${skipped.map((result) => `${result.label} (${result.reason ?? result.status})`).join(", ")}.`,
      "",
    );
  }

  push("## Summary", "");
  push(
    "| bot | status | protocol | session create | streaming granularity | cancel works? | resume / load | permission request shape | auth state |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const result of meta.results) {
    push(`| ${summaryRow(result).map(cell).join(" | ")} |`);
  }
  push("");

  push("## Per bot detail", "");
  for (const result of meta.results) {
    push(`### ${result.label}`, "");
    push("| field | value |", "| --- | --- |");
    for (const [key, value] of detailRows(result)) {
      push(`| ${cell(key)} | ${cell(value)} |`);
    }
    push("");
    if (result.notes.length) {
      push("Notes:", "");
      for (const note of result.notes) push(`- ${note}`);
      push("");
    }
    if (result.methods.requests.length) {
      const interesting = result.methods.requests.filter((method) =>
        /init|session|thread|turn|prompt|chat|message|resume|load|interrupt|cancel|abort|permission|approval|auth/i.test(method),
      );
      push(`Method inventory: ${result.methods.requests.length} client requests, ${result.methods.notifications.length} notifications, ${result.methods.serverRequests.length} server requests (full list in \`probes/out/summary.json\`).`);
      if (interesting.length) {
        const shown = interesting.slice(0, 24);
        push(
          "",
          `Session / turn related requests: ${shown.join(", ")}${interesting.length > shown.length ? `, and ${interesting.length - shown.length} more` : ""}.`,
        );
      }
      push("");
    }
  }

  push("## How to reproduce", "");
  push("```sh", "node probes/run.mjs --dry-run   # list the probes", "node probes/run.mjs            # run them and rewrite this file", 'node --test "probes/test/**/*.test.mjs"', "```", "");
  push(
    "The runner never passes credentials: it only asks each CLI for its own status and inherits the ambient environment.",
    "",
  );

  return meta.redactor.text(lines.join("\n"));
}
