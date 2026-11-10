import { test } from "node:test";
import assert from "node:assert/strict";
import { FileLocks, mutationPath } from "../src/locks.ts";
import { createRun } from "../src/state.ts";

const writer = () => createRun({ description: "Write", prompt: "Write" });
test("mutation paths normalize leading @ and relative aliases only for write/edit", () => {
  for (const tool of ["write", "edit"]) {
    assert.equal(mutationPath(tool, { path: "@src/../a.ts" }, "/work"), "/work/a.ts");
    assert.equal(mutationPath(tool, { path: "/work/a.ts" }, "/other"), "/work/a.ts");
    assert.equal(mutationPath(tool, { path: 123 }, "/work"), undefined);
  }
  assert.equal(mutationPath("bash", { path: "a.ts" }, "/work"), undefined);
});
test("main locks last until the last background writer settles, not just one", () => {
  const locks = new FileLocks(), a = writer(), b = writer();
  locks.start(a, "a"); locks.start(b, "b");
  locks.mainCall("main", "/work/a.ts"); locks.mainEnd("main", false);
  assert.match(locks.claim(a, "/work/a.ts")!, /locked by main/);
  locks.release(a);
  assert.match(locks.claim(b, "/work/a.ts")!, /locked by main/);
  locks.release(b);
  const c = writer(); locks.start(c, "c");
  assert.equal(locks.claim(c, "/work/a.ts"), undefined);
});
test("failed sibling main calls cannot remove successful or pending main locks", () => {
  const locks = new FileLocks(), a = writer(); locks.start(a, "a");
  locks.mainCall("first", "/work/a.ts"); locks.mainCall("second", "/work/a.ts");
  locks.mainEnd("first", true);
  assert.match(locks.claim(a, "/work/a.ts")!, /locked by main/);
  locks.mainEnd("second", false);
  locks.mainCall("third", "/work/a.ts"); locks.mainEnd("third", true);
  assert.match(locks.claim(a, "/work/a.ts")!, /locked by main/);
  locks.mainCall("failed", "/work/b.ts"); locks.mainEnd("failed", true);
  assert.equal(locks.claim(a, "/work/b.ts"), undefined);
});
test("a child may keep editing its own lock; shutdown drops all owners permanently", () => {
  const locks = new FileLocks(), a = writer(), b = writer();
  locks.start(a, "a"); locks.start(b, "b");
  assert.equal(locks.claim(a, "/work/a.ts"), undefined);
  assert.equal(locks.claim(a, "/work/a.ts"), undefined);
  assert.match(locks.claim(b, "/work/a.ts")!, /background agent a/);
  locks.shutdown(); locks.shutdown();
  assert.equal(locks.mainCall("main", "/work/a.ts"), undefined);
  assert.match(locks.claim(b, "/work/a.ts")!, /Session shut down/);
});
