// Tests for the host masking of the ssh family of commands.
//
// The scope of this file is the part of botd/src/redact.ts that masks the
// remote of `ssh`, `scp`, `sftp` and `rsync`, the top level domains the
// module treats as host names and the neighbours of those rules that have to
// stay readable.
//
// Every fixture is synthetic: the host names use the reserved top level
// domains of RFC 2606, the addresses come from the documentation ranges
// (RFC 5737 for IPv4, RFC 3849 for IPv6) and no real machine, person or
// credential is mentioned.

import test from "node:test";
import assert from "node:assert/strict";

import { redactText } from "../src/redact.ts";

/** The options that turn the host masking on. */
const HOST_MASK = { hostMask: true };

// --- sftp -----------------------------------------------------------------

test("redactText masks the target of an sftp", () => {
  assert.equal(redactText("sftp user@host", HOST_MASK), "sftp user@<host>");
});

test("redactText masks the target of an sftp with a domain", () => {
  assert.equal(redactText("sftp user@build-box.invalid", HOST_MASK), "sftp user@<host>");
});

test("redactText masks the target of an sftp behind a flag", () => {
  assert.equal(
    redactText("sftp -b batchfile user@build-box.invalid", HOST_MASK),
    "sftp -b batchfile user@<host>",
  );
});

// --- the flags of ssh -----------------------------------------------------

/**
 * The flags of `ssh` that swallow the next argument: the value belongs to
 * the flag, so it must not be taken for the target of the command.
 */
const SSH_VALUE_FLAG_CASES: { flag: string; input: string; expected: string }[] = [
  {
    flag: "-p",
    input: "ssh -p 2200 deploy@build-box.invalid",
    expected: "ssh -p 2200 deploy@<host>",
  },
  {
    flag: "-i",
    input: "ssh -i id_ed25519 deploy@build-box.invalid",
    expected: "ssh -i id_ed25519 deploy@<host>",
  },
  {
    flag: "-J",
    input: "ssh -J jumpbox deploy@build-box.invalid",
    expected: "ssh -J jumpbox deploy@<host>",
  },
  {
    flag: "-L",
    input: "ssh -L 8080:127.0.0.1:80 deploy@build-box.invalid",
    expected: "ssh -L 8080:<ip>:80 deploy@<host>",
  },
  {
    flag: "-o with a plain value",
    input: "ssh -o ForwardAgent deploy@build-box.invalid",
    expected: "ssh -o ForwardAgent deploy@<host>",
  },
  {
    flag: "-o with a key and a value",
    input: "ssh -o StrictHostKeyChecking=no deploy@build-box.invalid",
    expected: "ssh -o StrictHostKeyChecking=no deploy@<host>",
  },
];

for (const { flag, input, expected } of SSH_VALUE_FLAG_CASES) {
  test(`redactText skips the value of the ssh flag ${flag} when it looks for the target`, () => {
    assert.equal(redactText(input, HOST_MASK), expected);
  });
}

test("redactText masks a target that carries a port", () => {
  assert.equal(redactText("ssh deploy@build-box.invalid:2222", HOST_MASK), "ssh deploy@<host>:2222");
});

// --- the words after ssh --------------------------------------------------

test("redactText leaves an English word after ssh alone", () => {
  for (const word of ["please", "run", "the", "now"]) {
    assert.equal(redactText(`ssh ${word}`, HOST_MASK), `ssh ${word}`);
  }
});

test("redactText leaves a sentence after ssh alone", () => {
  assert.equal(
    redactText("ssh please run the job", HOST_MASK),
    "ssh please run the job",
  );
});

// --- the authority of a url -----------------------------------------------

test("redactText masks a bracketed ipv6 url authority with a port", () => {
  assert.equal(
    redactText("https://[2001:db8::1]:8443/status", HOST_MASK),
    "https://<ip>:8443/status",
  );
});

test("redactText masks a bracketed ipv6 url authority with a port and a userinfo", () => {
  assert.equal(
    redactText("https://deploy@[2001:db8::1]:8443/status", HOST_MASK),
    "https://<ip>:8443/status",
  );
});

// --- the remote spec of scp and rsync -------------------------------------

test("redactText masks the remote spec of an scp", () => {
  assert.equal(
    redactText("scp -r dir/ deploy@build-box.invalid:/srv/app/", HOST_MASK),
    "scp -r dir/ deploy@<host>:/srv/app/",
  );
});

test("redactText masks the remote spec of an rsync", () => {
  assert.equal(
    redactText("rsync -av src/ user@build-box.invalid:dest/sub/", HOST_MASK),
    "rsync -av src/ user@<host>:dest/sub/",
  );
});

test("redactText masks a remote spec without a user name", () => {
  assert.equal(
    redactText("scp notes.txt build-box.invalid:/srv/", HOST_MASK),
    "scp notes.txt <host>:/srv/",
  );
  assert.equal(
    redactText("rsync -av src/ build-box.invalid:dest/", HOST_MASK),
    "rsync -av src/ <host>:dest/",
  );
});

// --- the top level domains ------------------------------------------------

/** The top level domains the module documents as host names. */
const DOCUMENTED_TLDS = [
  "ai",
  "app",
  "cloud",
  "com",
  "dev",
  "example",
  "internal",
  "invalid",
  "io",
  "lan",
  "local",
  "net",
  "org",
  "test",
];

for (const tld of DOCUMENTED_TLDS) {
  test(`redactText masks a host name under .${tld}`, () => {
    assert.equal(redactText(`the box is build-box.${tld}`, HOST_MASK), "the box is <host>");
  });
}

test("redactText leaves a name under an unknown top level domain alone", () => {
  assert.equal(redactText("the box is build-box.co", HOST_MASK), "the box is build-box.co");
});

test("redactText leaves a name whose top level domain only starts like a documented one alone", () => {
  assert.equal(
    redactText("the box is build-box.examplex", HOST_MASK),
    "the box is build-box.examplex",
  );
});

// --- the file names -------------------------------------------------------

test("redactText leaves a dotted file name alone", () => {
  for (const name of ["config.json", "tsconfig.json", "notes.rst"]) {
    assert.equal(redactText(`open ${name}`, HOST_MASK), `open ${name}`);
  }
});

// --- the host mask is optional --------------------------------------------

test("redactText leaves the hosts alone when the host mask is off", () => {
  assert.equal(redactText("sftp user@build-box.invalid"), "sftp user@build-box.invalid");
  assert.equal(
    redactText("https://[2001:db8::1]:8443/status"),
    "https://[2001:db8::1]:8443/status",
  );
  assert.equal(
    redactText("ssh -i id_ed25519 deploy@build-box.invalid"),
    "ssh -i id_ed25519 deploy@build-box.invalid",
  );
  assert.equal(redactText("open config.json"), "open config.json");
});

// --- the defects ----------------------------------------------------------

// TODO(defect): the copy tools only look at the last token of the command
// line, so a remote spec that is not the last token keeps its host name.
test.todo("redactText masks the remote spec of an rsync that is not the last token", () => {
  const output = redactText("rsync -av src/ user@build-box:dest/ --exclude foo", HOST_MASK);

  assert.ok(!output.includes("build-box"), "the host name of the remote spec survived");
  assert.ok(output.includes("--exclude foo"), "the rest of the command line was lost");
});

// TODO(defect): the `::` of an rsync remote daemon spec is taken for a
// compressed ipv6 address, so the host name is mangled and leaks.
test.todo("redactText masks the remote daemon spec of an rsync", () => {
  const output = redactText("rsync -av src/ user@build-box.invalid::dest/", HOST_MASK);

  assert.ok(!output.includes("build-box"), "the host name of the remote spec survived");
  assert.equal(output, "rsync -av src/ user@<host>::dest/");
});
