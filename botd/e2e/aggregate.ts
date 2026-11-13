/**
 * Entry point of the botd end-to-end suite.
 *
 * `node --test botd/e2e` resolves the directory to this file (see
 * botd/e2e/package.json); importing the test modules here runs the whole
 * suite. Every test starts the real daemon as a child process, so the
 * suite needs a runtime that can execute TypeScript directly.
 */
import "./stream.test.ts";
import "./resume.test.ts";
import "./lease.test.ts";
import "./cancel.test.ts";
