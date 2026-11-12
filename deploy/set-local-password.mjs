#!/usr/bin/env node
// Sets the password of an existing local member in the OpenBot team store.
//
// The Team API has no password route for a member that is not signed in, so the store file is
// the only place the hash can change. The hash must match TeamStore.hashPasswordEffect in
// src/main/team-store.ts:
//   salt = randomBytes(16).toString("base64url")
//   hash = scrypt(password, salt, 64) -> base64url
//
// Usage: node set-local-password.mjs <team-store-file> <username> <password-file>
// The password is read from a file, never from the command line, so it never lands in the
// process table or in a shell history.

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const [, , storePath, username, passwordPath] = process.argv;
if (!storePath || !username || !passwordPath) {
  console.error("usage: set-local-password.mjs <team-store-file> <username> <password-file>");
  process.exit(2);
}

const password = readFileSync(passwordPath, "utf8").trim();
if (!password) {
  console.error("the password file is empty");
  process.exit(2);
}

const file = JSON.parse(readFileSync(storePath, "utf8"));
const host = file.hosts?.[0];
if (!host) {
  console.error("no host found in the team store file");
  process.exit(1);
}

const normalized = username.trim().toLowerCase();
const member = host.members.find((candidate) => candidate.username === normalized);
if (!member) {
  console.error(`member ${normalized} not found`);
  process.exit(1);
}

const salt = randomBytes(16).toString("base64url");
const hash = Buffer.from(await scrypt(password, salt, 64)).toString("base64url");

member.passwordSalt = salt;
member.passwordHash = hash;
// A member that changed password must not keep a session opened with the old one.
host.sessions = (host.sessions ?? []).filter((session) => session.memberId !== member.id);

// Keep a timestamped backup next to the file before writing, so a bad write is recoverable.
copyFileSync(storePath, `${storePath}.bak-${Date.now()}`);

writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, { mode: statSync(storePath).mode });
console.log(`updated password for ${normalized} (id ${member.id})`);
console.log(`salt=${salt.length} chars, hash=${hash.length} chars`);
