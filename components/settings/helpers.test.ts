import { describe, expect, it } from "vitest";
import {
  defaultAt, delAt, getAt, isChanged, isEqual, issuesUnder, listAdd, listMove, listRemove, listUpdate,
  pathToString, pruneGears, regexError, renameKey, revertAt, setAt, setBandMax, uniqueKey,
} from "./helpers";

const defaults = {
  tiers: {
    trivial: { min: 0, max: 2 }, small: { min: 3, max: 5 }, medium: { min: 6, max: 8 },
    large: { min: 9, max: 11 }, xlarge: { min: 12, max: 14 },
  },
  gears: { "*": { small: { model: "@small" } } },
  scoring: { classes: [{ id: "a", label: "A", floor: 3, patterns: ["x"] }, { id: "b", label: "B", add: 2, patterns: [] }] },
};

describe("path edits", () => {
  it("sets and deletes immutably", () => {
    const next = setAt(defaults, ["gears", "codex", "small", "model"], "m");
    expect(getAt(next, ["gears", "codex", "small", "model"])).toBe("m");
    expect(getAt(defaults, ["gears", "codex"])).toBeUndefined();
    const gone = delAt(next, ["gears", "codex", "small", "model"]);
    expect(getAt(gone, ["gears", "codex"])).toBeUndefined();
  });
  it("compares deeply", () => {
    expect(isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(isEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe("change detection", () => {
  it("matches classes by id, not position", () => {
    const draft = { ...defaults, scoring: { classes: [defaults.scoring.classes[1]!, { ...defaults.scoring.classes[0]!, floor: 5 }] } };
    expect(isChanged(defaults, draft, ["scoring", "classes", 0, "add"])).toBe(false);
    expect(isChanged(defaults, draft, ["scoring", "classes", 1, "floor"])).toBe(true);
    expect(defaultAt(defaults, draft, ["scoring", "classes", 1, "floor"])).toBe(3);
    expect(pathToString(draft, ["scoring", "classes", 1, "patterns", 0])).toBe("scoring.classes[a].patterns[0]");
  });
  it("reverts a field, and removes a custom class", () => {
    const edited = setAt(defaults, ["scoring", "classes", 0, "floor"], 9);
    expect(getAt(revertAt(defaults, edited, ["scoring", "classes", 0, "floor"]), ["scoring", "classes", 0, "floor"])).toBe(3);
    const custom = setAt(defaults, ["scoring", "classes", 2], { id: "c", label: "C", patterns: [] });
    expect(getAt(revertAt(defaults, custom, ["scoring", "classes", 2]), ["scoring", "classes"])).toHaveLength(2);
  });
  it("treats a provider-only gear as changed and reverts by deleting", () => {
    const draft = setAt(defaults, ["gears", "codex", "small"], { model: "x" });
    expect(isChanged(defaults, draft, ["gears", "codex", "small"])).toBe(true);
    expect(pruneGears(revertAt(defaults, draft, ["gears", "codex", "small"])).gears).toEqual(defaults.gears);
  });
});

describe("issues", () => {
  it("finds errors by path prefix", () => {
    const issues = [{ path: "scoring.classes[a].patterns[0]", message: "bad" }, { path: "routing.x", message: "n" }];
    expect(issuesUnder(issues, "scoring.classes[a]")).toHaveLength(1);
    expect(issuesUnder(issues, "scoring.classes[ab]")).toHaveLength(0);
  });
  it("reports regex problems", () => {
    expect(regexError("\\bfoo\\b")).toBeNull();
    expect(regexError("(")).not.toBeNull();
  });
});

describe("pattern lists", () => {
  it("edits, adds, removes and moves", () => {
    expect(listUpdate(["a", "b"], 1, "c")).toEqual(["a", "c"]);
    expect(listAdd(["a"])).toEqual(["a", ""]);
    expect(listRemove(["a", "b"], 0)).toEqual(["b"]);
    expect(listMove(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(listMove(["a"], 0, -1)).toEqual(["a"]);
  });
});

describe("bands and rows", () => {
  it("keeps bands contiguous", () => {
    const next = setBandMax(defaults.tiers, "small", 6);
    expect(next.medium.min).toBe(7);
    expect(defaults.tiers.medium.min).toBe(6);
  });
  it("renames keys in place and finds unique keys", () => {
    expect(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, "b", "z"))).toEqual(["a", "z", "c"]);
    expect(renameKey({ a: 1, b: 2 }, "a", "b")).toEqual({ a: 1, b: 2 });
    expect(uniqueKey({ model: 1, "model-2": 1 }, "model")).toBe("model-3");
  });
});

import { describeResolution, resolveModelClient, type ModelInfo } from "./gear-resolve";

const models: ModelInfo[] = [
  { id: "m-large", label: "Big 2", isDefault: false, efforts: ["low", "high"], serviceTiers: ["fast"], sizeClass: "large" },
  { id: "m-med", label: "Mid 2", isDefault: true, efforts: ["low", "medium", "high"], serviceTiers: [], sizeClass: "medium" },
];

describe("gear resolution", () => {
  it("resolves classes, defaults and families", () => {
    expect(resolveModelClient("@large", models)?.id).toBe("m-large");
    expect(resolveModelClient("@small", models)?.id).toBe("m-med");
    expect(resolveModelClient("@default", models)?.id).toBe("m-med");
    expect(resolveModelClient("big", models)?.id).toBe("m-large");
    expect(resolveModelClient("nope", models)).toBeNull();
  });
  it("describes with clamped effort and applicable tier", () => {
    expect(describeResolution({ model: "@large", effort: "medium", serviceTier: "fast" }, models)).toBe("Big 2 · low · fast");
    expect(describeResolution({ model: "x" }, models)).toBe("No matching model");
    expect(describeResolution({ model: "x" }, null)).toBe("Models unavailable");
  });
});
