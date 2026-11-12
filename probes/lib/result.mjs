// probes/lib/result.mjs
//
// Every probe produces the same result shape so that probes/REPORT.md can be
// rendered from a single table.

/**
 * @typedef {Object} ProbeResult
 * @property {string} id
 * @property {string} label
 * @property {"ok"|"skipped"|"failed"|"timeout"} status
 * @property {string} [reason]
 * @property {{ command: string, available: boolean, path?: string, version?: string }} binary
 * @property {{ state: string, evidence: string }} auth
 * @property {Object} protocol
 * @property {Record<string, number|null>} timings
 * @property {{ requests: string[], notifications: string[], serverRequests: string[] }} methods
 * @property {string[]} notes
 * @property {string} transcript
 */

/**
 * Mark every runtime observation as "not probed" so the report shows the
 * expected protocol shape instead of empty cells.
 *
 * @param {ProbeResult} result
 * @param {string} [reason]
 */
export function markNotProbed(result, reason = "not probed (binary missing)") {
  result.protocol.sessionCreate.supported = null;
  result.protocol.sessionCreate.detail = reason;
  result.protocol.streaming.granularity = "unknown";
  result.protocol.streaming.detail = reason;
  result.protocol.cancel.works = null;
  result.protocol.cancel.detail = reason;
  result.protocol.resume.supported = null;
  result.protocol.resume.detail = reason;
  result.auth.state = "unknown";
  result.auth.evidence = reason;
}

export function createResult(meta) {
  return {
    id: meta.id,
    label: meta.label,
    status: "failed",
    binary: { command: meta.command, available: false },
    auth: { state: "unknown", evidence: "not probed" },
    protocol: {
      name: "unknown",
      transport: "unknown",
      framing: "unknown",
      sessionCreate: { supported: null, method: "", detail: "" },
      streaming: { granularity: "unknown", detail: "", samples: 0 },
      cancel: { works: null, method: "", detail: "" },
      resume: { supported: null, method: "", detail: "" },
      permissions: { shape: "unknown", observed: [] },
    },
    timings: {
      initializeMs: null,
      sessionCreateMs: null,
      firstOutputMs: null,
      promptMs: null,
      cancelMs: null,
      totalMs: null,
    },
    methods: { requests: [], notifications: [], serverRequests: [] },
    notes: [],
    transcript: "",
  };
}
