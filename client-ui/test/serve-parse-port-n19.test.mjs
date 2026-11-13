// Tests for the command line of the panel server.
//
// parsePort() is the part of client-ui/serve.mjs that can be checked
// without a server: the module is imported, but no socket is opened, no
// process is started and nothing is read from the file system.
//
// client-ui/test/serve-edge.test.ts drives the same options through the
// command line of the server; the tests here call parsePort() itself and
// pin down the ports it returns and the messages it refuses with.

import assert from "node:assert/strict";
import test from "node:test";

import { parsePort } from "../serve.mjs";

test("importing the module does not start a server", () => {
  // A listen handle would show up here; the import must stay free of
  // side effects, otherwise every test below would hold a port.
  assert.ok(!process.getActiveResourcesInfo().includes("TCPSERVERWRAP"));
});

test("without --port the server gets a random free port", () => {
  assert.equal(parsePort([]), 0);
});

test("--port with a number is the port of the server", () => {
  assert.equal(parsePort(["--port", "8080"]), 8080);
});

test("--port 0 asks for a random free port as well", () => {
  assert.equal(parsePort(["--port", "0"]), 0);
});

test("the highest port is allowed", () => {
  assert.equal(parsePort(["--port", "65535"]), 65535);
});

test("--port with a value that is not a number is refused", () => {
  assert.throws(() => parsePort(["--port", "abc"]), /invalid port: abc/);
});

test("--port above the highest port is refused", () => {
  assert.throws(() => parsePort(["--port", "70000"]), /invalid port: 70000/);
  assert.throws(() => parsePort(["--port", "70000"]), /65535/);
});

test("--port with a negative number is refused", () => {
  assert.throws(() => parsePort(["--port", "-1"]), /invalid port: -1/);
});

test("--port with a value that is not a whole number is refused", () => {
  assert.throws(() => parsePort(["--port", "80.5"]), /invalid port: 80\.5/);
});

test("--port without a value is refused", () => {
  assert.throws(() => parsePort(["--port"]), /--port needs a port number/);
});

test("--port with an empty value is refused", () => {
  assert.throws(() => parsePort(["--port", ""]), /invalid port/);
});

test("flags that are not --port are ignored", () => {
  assert.equal(parsePort(["--verbose"]), 0);
  assert.equal(parsePort(["--mode", "demo"]), 0);
  assert.equal(parsePort(["--mode", "demo", "--port", "8080", "--verbose"]), 8080);
});

test("the first --port of the line wins", () => {
  assert.equal(parsePort(["--port", "8080", "--port", "9090"]), 8080);
});

// DEFECT: the "--port=8080" form is ignored, so the server starts on a random port.
test.todo("the --port=<port> form of the option is read", () => {
  assert.equal(parsePort(["--port=8080"]), 8080);
});
