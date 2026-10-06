import { describe, expect, it } from "vitest";
import { analyzeGraph, tidyDependencies } from "../src/shared/domain/graph";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import type { RequestNode } from "../src/shared/domain/types";
import { simulateProject } from "../src/shared/domain/simulation";
import {
  addRequestNode,
  toggleDependency,
} from "../src/features/graph-editor/graphViewModel";

function makeNode(
  id: string,
  name: string,
  dependencyIds: string[] = [],
): RequestNode {
  return {
    id,
    name,
    durationMs: 100,
    jitterMs: 0,
    dependencyIds,
    timeoutMs: 500,
    retryCount: 0,
    failureRate: 0,
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
  it("flags transitively redundant edges instead of treating them as order conflicts", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [
        makeNode("a", "网关鉴权"),
        makeNode("b", "账户信息", ["a"]),
        makeNode("c", "权益校验", ["b", "a"]),
      ],
    };
    const analysis = analyzeGraph(project);
    expect(analysis.validation.errors).toHaveLength(0);
    expect(analysis.dependencyIssues).toHaveLength(1);
    const issue = analysis.dependencyIssues[0];
    expect(issue?.kind).toBe("redundant");
    expect(issue?.nodeId).toBe("c");
    expect(issue?.dependencyId).toBe("a");
    expect(issue?.message).toContain("多余");
    expect(issue?.message).toContain("账户信息");
    expect(analysis.validation.warnings.join(" ")).toContain("多余");
  });

  it("flags dependencies that point backwards against the segment order", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [
        makeNode("first", "先发请求", ["second"]),
        makeNode("second", "后续请求"),
      ],
    };
    const analysis = analyzeGraph(project);
    expect(analysis.validation.errors).toHaveLength(0);
    expect(analysis.dependencyIssues).toHaveLength(1);
    expect(analysis.dependencyIssues[0]?.kind).toBe("order");
    expect(analysis.dependencyIssues[0]?.message).toContain("顺序");
  });

  it("tidies redundant edges and segment order as one atomic step", () => {
    const project = {
      ...EXAMPLE_PROJECT,
      nodes: [
        makeNode("b", "账户信息", ["a"]),
        makeNode("a", "网关鉴权"),
        makeNode("c", "权益校验", ["b", "a"]),
      ],
    };
    const before = simulateProject(project);
    const tidy = tidyDependencies(project);
    expect(tidy.removedEdges).toEqual([{ nodeId: "c", dependencyId: "a" }]);
    expect(tidy.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(tidy.movedCount).toBe(2);
    const after = simulateProject({ ...project, nodes: tidy.nodes });
    expect(after.completionMs).toBe(before.completionMs);
    expect(after.entries.map((entry) => entry.nodeId)).toEqual(
      before.entries.map((entry) => entry.nodeId),
    );
    const reanalyzed = analyzeGraph({ ...project, nodes: tidy.nodes });
    expect(reanalyzed.dependencyIssues).toHaveLength(0);
    const again = tidyDependencies({ ...project, nodes: tidy.nodes });
    expect(again.removedEdges).toHaveLength(0);
    expect(again.movedCount).toBe(0);
  });

  it("refuses to tidy a graph that still has validation errors", () => {
    const cyclic = {
      ...EXAMPLE_PROJECT,
      nodes: [makeNode("a", "甲", ["b"]), makeNode("b", "乙", ["a"])],
    };
    const tidy = tidyDependencies(cyclic);
    expect(tidy.nodes).toBe(cyclic.nodes);
    expect(tidy.removedEdges).toHaveLength(0);
    expect(tidy.movedCount).toBe(0);
  });
});
