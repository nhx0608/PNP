import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonObject, toJson } from "../../../src/drivers/acp/json.ts";

/**
 * Everything an engine sends reaches the public event stream through this converter, so a value it cannot
 * represent has to become an explicit null rather than crash the turn or leak a live object reference.
 */

test("plain values survive the conversion unchanged", () => {
  assert.deepEqual(toJson({ a: "text", b: 1, c: true, d: null, e: [1, "two", false] }),
    { a: "text", b: 1, c: true, d: null, e: [1, "two", false] });
});

test("a value that is not representable becomes null instead of failing the turn", () => {
  assert.equal(toJson(Number.NaN), null);
  assert.equal(toJson(Number.POSITIVE_INFINITY), null);
  assert.equal(toJson(undefined), null);
  assert.equal(toJson(() => undefined), null);
  assert.equal(toJson(Symbol("s")), null);
});

test("a big integer keeps its digits rather than losing precision to a float", () => {
  assert.equal(toJson(90071992547409911n), "90071992547409911");
});

test("an absent property is dropped, not turned into a null field", () => {
  assert.deepEqual(toJson({ present: 1, absent: undefined }), { present: 1 });
});

test("a cycle is cut instead of overflowing the stack", () => {
  const node: { name: string; self?: unknown } = { name: "loop" };
  node.self = node;
  assert.deepEqual(toJson(node), { name: "loop", self: null });
});

test("a cycle through an array is cut too", () => {
  const list: unknown[] = ["head"];
  list.push(list);
  assert.deepEqual(toJson(list), ["head", null]);
});

test("the same object appearing twice side by side is kept both times", () => {
  const shared = { id: "shared" };
  // Only an ancestor counts as a cycle; a repeated sibling is ordinary data an engine may well send.
  assert.deepEqual(toJson({ left: shared, right: shared }), { left: { id: "shared" }, right: { id: "shared" } });
});

test("nesting deeper than the driver's limit is cut at the limit", () => {
  let deep: { next?: unknown } = {};
  const root = deep;
  for (let level = 0; level < 20; level += 1) {
    const next: { next?: unknown } = {};
    deep.next = next;
    deep = next;
  }
  let cursor: unknown = toJson(root);
  let depth = 0;
  while (cursor !== null && typeof cursor === "object" && !Array.isArray(cursor) && "next" in cursor) {
    cursor = (cursor as { next: unknown }).next;
    depth += 1;
  }
  assert.equal(cursor, null);
  assert.ok(depth <= 16, `nesting was preserved ${String(depth)} levels deep`);
});

test("a non-object payload is normalised to an empty object rather than passed through", () => {
  assert.deepEqual(jsonObject(null), {});
  assert.deepEqual(jsonObject(undefined), {});
  assert.deepEqual(jsonObject("params"), {});
  assert.deepEqual(jsonObject([1, 2]), {});
  assert.deepEqual(jsonObject({ update: { sessionUpdate: "plan" } }), { update: { sessionUpdate: "plan" } });
});
