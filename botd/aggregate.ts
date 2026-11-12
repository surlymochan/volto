/**
 * Entry point of the botd test suite.
 *
 * `node --test botd/test` resolves the directory to this file (see
 * botd/test/package.json), because Node 22 does not expand a directory
 * argument on its own. Importing the test modules here runs the whole suite.
 */
import "./test/protocol.test.ts";
import "./test/ring.test.ts";
import "./test/lease.test.ts";
import "./test/session.test.ts";
import "./test/store.test.ts";
import "./test/daemon.test.ts";
import "./test/cli.test.ts";
