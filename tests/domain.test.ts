import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT, type RequestNode } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  tidyDependencies,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";

function hygieneNode(
  id: string,
  name: string,
  dependencyIds: string[],
  durationMs = 100,
): RequestNode {
  return {
    id,
    name,
    durationMs,
    jitterMs: 0,
    dependencyIds,
    timeoutMs: 1000,
    retryCount: 0,
    failureRate: 0,
  };
}

function hygieneProject() {
  return {
    ...EXAMPLE_PROJECT,
    nodes: [
      hygieneNode("a", "分段A", []),
      hygieneNode("b", "分段B", ["a"]),
      hygieneNode("c", "分段C", ["a", "b"]),
      hygieneNode("d", "分段D", ["e"]),
      hygieneNode("e", "分段E", []),
    ],
  };
}

describe("request dependency graph", () => {
  it("orders a DAG and detects a cycle before simulation", () => {
    const project = structuredClone(EXAMPLE_PROJECT);
    expect(analyzeGraph(project).order).toHaveLength(project.nodes.length);
    const cyclic = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session" ? { ...node, dependencyIds: ["profile"] } : node,
      ),
    };
    expect(analyzeGraph(cyclic).validation.errors.join(" ")).toContain(
      "循环依赖",
    );
    expect(simulateProject(cyclic).entries).toHaveLength(0);
  });

  it("rejects cyclic edges and accepts valid dependencies", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 3),
    };
    const accepted = toggleDependency(project, "profile", "flags");
    expect(accepted.error).toBeUndefined();
    const rejected = toggleDependency(accepted.project, "flags", "profile");
    expect(rejected.error).toContain("循环");
    expect(rejected.project).toEqual(accepted.project);
  });

  it("schedules independent roots in parallel and serializes them at concurrency one", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2).map((node) => ({
        ...node,
        durationMs: 300,
        jitterMs: 0,
        timeoutMs: 1000,
        retryCount: 0,
        failureRate: 0,
      })),
    };
    const parallel = simulateProject(project);
    const serial = simulateProject({ ...project, concurrencyLimit: 1 });
    expect(parallel.completionMs).toBe(300);
    expect(serial.completionMs).toBe(600);
    expect(serial.entries[1]?.waitMs).toBe(300);
  });

  it("applies jitter modes, timeout caps, bounded retries, and fallback probability", () => {
    const node = {
      id: "a",
      name: "slow",
      durationMs: 1200,
      jitterMs: 400,
      dependencyIds: [],
      timeoutMs: 1000,
      retryCount: 1,
      failureRate: 50,
      fallbackNodeId: "b",
    };
    const fallback = {
      ...node,
      id: "b",
      name: "fallback",
      durationMs: 200,
      jitterMs: 0,
      timeoutMs: 500,
      retryCount: 0,
      failureRate: 0,
      fallbackNodeId: undefined,
    };
    const project = { ...EXAMPLE_PROJECT, nodes: [node, fallback] };
    const low = simulateProject(project, "low");
    const expected = simulateProject(project, "expected");
    const high = simulateProject(project, "high");
    expect(low.completionMs).toBeLessThanOrEqual(expected.completionMs);
    expect(expected.completionMs).toBeLessThanOrEqual(high.completionMs);
    expect(high.warnings.join(" ")).toContain("超时");
    expect(high.entries[0]?.modeledDurationMs).toBe(1650);
    const invalid = {
      ...project,
      nodes: [{ ...node, retryCount: 9 }, fallback],
    };
    expect(simulateProject(invalid).entries).toHaveLength(0);
  });

  it("creates an editable request node with safe defaults", () => {
    const project = { ...EXAMPLE_PROJECT, nodes: [] };
    const next = addRequestNode(project);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.durationMs).toBe(400);
    expect(next.nodes[0]?.dependencyIds).toEqual([]);
  });
});

describe("dependency hygiene", () => {
  it("flags redundant edges and reversed directions in validation", () => {
    const analysis = analyzeGraph(hygieneProject());
    expect(analysis.issues).toHaveLength(2);
    const redundant = analysis.issues.find(
      (issue) => issue.kind === "redundant",
    );
    expect(redundant?.nodeId).toBe("c");
    expect(redundant?.dependencyId).toBe("a");
    expect(redundant?.viaId).toBe("b");
    expect(redundant?.message).toContain("多余连线");
    const reversed = analysis.issues.find((issue) => issue.kind === "reversed");
    expect(reversed?.nodeId).toBe("d");
    expect(reversed?.dependencyId).toBe("e");
    expect(reversed?.message).toContain("顺序冲突");
    expect(analysis.validation.warnings.join(" ")).toContain("多余连线");
    expect(analysis.validation.warnings.join(" ")).toContain("顺序冲突");
  });

  it("tidies dependencies as one atomic pass without mutating the input", () => {
    const project = hygieneProject();
    const outcome = tidyDependencies(project);
    expect(outcome.changes.map((change) => change.kind).sort()).toEqual([
      "removed",
      "reversed",
    ]);
    const byId = new Map(
      outcome.project.nodes.map((node) => [node.id, node] as const),
    );
    expect(byId.get("c")?.dependencyIds).toEqual(["b"]);
    expect(byId.get("d")?.dependencyIds).toEqual([]);
    expect(byId.get("e")?.dependencyIds).toEqual(["d"]);
    const analysis = analyzeGraph(outcome.project);
    expect(analysis.issues).toHaveLength(0);
    expect(analysis.validation.errors).toHaveLength(0);
    expect(project.nodes.find((node) => node.id === "c")?.dependencyIds).toEqual(
      ["a", "b"],
    );
    expect(outcome.project.scenarios).toBe(project.scenarios);
  });

  it("keeps the budget identical when only redundant edges are removed", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [
        hygieneNode("a", "分段A", [], 100),
        hygieneNode("b", "分段B", ["a"], 200),
        hygieneNode("c", "分段C", ["a", "b"], 300),
      ],
    };
    const before = simulateProject(project);
    const outcome = tidyDependencies(project);
    expect(outcome.changes.every((change) => change.kind === "removed")).toBe(
      true,
    );
    const after = simulateProject(outcome.project);
    expect(after.completionMs).toBe(before.completionMs);
    expect(after.entries.map((entry) => entry.nodeId)).toEqual(
      before.entries.map((entry) => entry.nodeId),
    );
  });

  it("aligns the timeline with the segment order after reversing a conflict", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [hygieneNode("d", "分段D", ["e"]), hygieneNode("e", "分段E", [])],
    };
    const before = simulateProject(project);
    expect(before.entries[0]?.nodeId).toBe("e");
    const outcome = tidyDependencies(project);
    expect(outcome.changes).toEqual([
      expect.objectContaining({ kind: "reversed", nodeId: "d" }),
    ]);
    const after = simulateProject(outcome.project);
    expect(after.entries[0]?.nodeId).toBe("d");
    expect(after.completionMs).toBe(before.completionMs);
  });

  it("keeps edges whose reversal would reintroduce a cycle", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [hygieneNode("x", "分段X", ["y"]), hygieneNode("y", "分段Y", ["x"])],
    };
    const outcome = tidyDependencies(project);
    expect(outcome.changes).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0]?.reason).toContain("保留原连线");
    expect(outcome.project).toBe(project);
  });
});
