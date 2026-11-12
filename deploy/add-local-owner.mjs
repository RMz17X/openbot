#!/usr/bin/env node
// Adds a local owner member with a username and password to the OpenBot team store.
//
// The team store is the only place a local member can be created: the Team API has no
// POST /v1/team/members, and the invite route needs an authenticated admin. The existing owner
// member (the account-service one) has no passwordHash, so it can never log in locally.
//
// The password hash must match TeamStore.hashPasswordEffect in src/main/team-store.ts:
//   salt = randomBytes(16).toString("base64url")
//   hash = scrypt(password, salt, 64) -> base64url
// The daemon verifies with the same scrypt call, so any other scheme fails to log in.
//
// Usage: node add-local-owner.mjs <team-store-file> <username> <password-file>
// The password is read from a file, never from the command line, so it never lands in the
// process table or in a shell history.

import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

const [, , storePath, username, passwordPath] = process.argv;
if (!storePath || !username || !passwordPath) {
  console.error("usage: add-local-owner.mjs <team-store-file> <username> <password-file>");
  process.exit(2);
}

const password = readFileSync(passwordPath, "utf8").trim();
if (password.length < 12 || password.length > 256) {
  console.error("password must be 12 to 256 characters");
  process.exit(2);
}
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/.test(username)) {
  console.error("username does not match the TeamStore username rule");
  process.exit(2);
}

const salt = randomBytes(16).toString("base64url");
const hash = Buffer.from(await scrypt(password, salt, 64)).toString("base64url");

const file = JSON.parse(readFileSync(storePath, "utf8"));
const host = file.hosts?.[0];
if (!host) {
  console.error("no host found in the team store file");
  process.exit(1);
}

const normalized = username.trim().toLowerCase();
if (host.members.some((member) => member.username === normalized)) {
  console.error(`member ${normalized} already exists`);
  process.exit(1);
}

// A local member has no accountId: it belongs to no account service user.
const member = {
  id: randomUUID(),
  username: normalized,
  email: null,
  name: null,
  avatarUrl: null,
  role: "owner",
  disabled: false,
  createdAt: new Date().toISOString(),
  passwordSalt: salt,
  passwordHash: hash,
};

host.members.push(member);

// Keep a timestamped backup next to the file before writing, so a bad write is recoverable.
copyFileSync(storePath, `${storePath}.bak-${Date.now()}`);

writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, { mode: statSync(storePath).mode });
console.log(`added member ${normalized} with id ${member.id}`);
console.log(`members now: ${host.members.map((m) => `${m.username}(${m.role})`).join(", ")}`);
