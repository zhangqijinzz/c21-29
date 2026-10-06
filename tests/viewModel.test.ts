import { describe, expect, it } from "vitest";
import {
  createProject,
  duplicateProject,
  selectProject,
} from "../src/features/projects/projectViewModel";
import {
  compareScenarios,
  restoreScenario,
  saveScenario,
} from "../src/features/scenarios/scenarioViewModel";
import { tidyProjectDependencies } from "../src/features/graph-editor/graphViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import type { RequestNode } from "../src/shared/domain/types";

const tidyFixture: RequestNode[] = [
  {
    id: "a",
    name: "网关鉴权",
    durationMs: 100,
    jitterMs: 0,
    dependencyIds: [],
    timeoutMs: 500,
    retryCount: 0,
    failureRate: 0,
  },
  {
    id: "b",
    name: "账户信息",
    durationMs: 100,
    jitterMs: 0,
    dependencyIds: ["a"],
    timeoutMs: 500,
    retryCount: 0,
    failureRate: 0,
  },
  {
    id: "c",
    name: "权益校验",
    durationMs: 100,
    jitterMs: 0,
    dependencyIds: ["b", "a"],
    timeoutMs: 500,
    retryCount: 0,
    failureRate: 0,
  },
];

describe("project and scenario view models", () => {
  it("creates a project and switches the active project", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const created = createProject(initial, 100);
    expect(created.projects).toHaveLength(2);
    expect(created.activeProjectId).not.toBe(EXAMPLE_PROJECT.id);
    expect(selectProject(created, EXAMPLE_PROJECT.id).activeProjectId).toBe(
      EXAMPLE_PROJECT.id,
    );
  });

  it("duplicates a project and remaps its dependency identities", () => {
    const initial = {
      version: 1 as const,
      activeProjectId: EXAMPLE_PROJECT.id,
      projects: [EXAMPLE_PROJECT],
    };
    const duplicated = duplicateProject(initial, EXAMPLE_PROJECT, 10);
    const copy = duplicated.projects[0];
    expect(copy?.nodes[2]?.dependencyIds).toEqual([copy?.nodes[0]?.id]);
    expect(copy?.nodes[4]?.fallbackNodeId).toBe(copy?.nodes[3]?.id);
    expect(copy?.id).not.toBe(EXAMPLE_PROJECT.id);
    expect(copy?.scenarios).toEqual([]);
  });

  it("saves a complete snapshot and restores its parameters", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const result = simulateProject(baseline);
    const saved = saveScenario(baseline, result, "并发方案");
    expect(saved.scenarios).toHaveLength(1);
    const changed = {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, durationMs: 999 })),
    };
    const restored = restoreScenario(changed, saved.scenarios[0]?.id ?? "");
    expect(restored.nodes[0]?.durationMs).toBe(baseline.nodes[0]?.durationMs);
  });

  it("describes node and concurrency differences between snapshots", () => {
    const baseline = {
      ...EXAMPLE_PROJECT,
      nodes: EXAMPLE_PROJECT.nodes.slice(0, 2),
    };
    const baselineSnapshot = saveScenario(
      baseline,
      simulateProject(baseline),
      "不限并发",
    ).scenarios[0];
    const changed = {
      ...baseline,
      concurrencyLimit: 1,
      nodes: baseline.nodes.map((node, index) =>
        index === 0 ? { ...node, durationMs: 900 } : node,
      ),
    };
    const changedSnapshot = saveScenario(
      changed,
      simulateProject(changed),
      "串行优化",
    ).scenarios[0];
    if (!baselineSnapshot || !changedSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(baselineSnapshot, changedSnapshot);
    expect(comparison.deltaMs).toBeGreaterThan(0);
    expect(comparison.changes.join(" ")).toContain("并发上限");
    expect(comparison.changes.join(" ")).toContain("耗时");
  });

  it("keeps saved snapshots untouched when tidying dependencies", () => {
    const base = { ...EXAMPLE_PROJECT, nodes: tidyFixture };
    const saved = saveScenario(base, simulateProject(base), "整理前");
    const outcome = tidyProjectDependencies(saved);
    expect(outcome.removedEdges).toEqual([{ nodeId: "c", dependencyId: "a" }]);
    expect(outcome.project.scenarios).toBe(saved.scenarios);
    expect(outcome.project.scenarios[0]?.nodes).toEqual(
      saved.scenarios[0]?.nodes,
    );
    const clean = tidyProjectDependencies(outcome.project);
    expect(clean.removedEdges).toHaveLength(0);
    expect(clean.movedCount).toBe(0);
    expect(clean.project).toBe(outcome.project);
  });

  it("names added and removed dependencies when comparing snapshots", () => {
    const base = { ...EXAMPLE_PROJECT, nodes: tidyFixture };
    const beforeSnapshot = saveScenario(base, simulateProject(base), "整理前")
      .scenarios[0];
    const tidied = tidyProjectDependencies(base).project;
    const afterSnapshot = saveScenario(
      tidied,
      simulateProject(tidied),
      "整理后",
    ).scenarios[0];
    if (!beforeSnapshot || !afterSnapshot)
      throw new Error("Scenario fixtures should be saved");
    const comparison = compareScenarios(beforeSnapshot, afterSnapshot);
    expect(comparison.changes.join(" ")).toContain("前置依赖 −「网关鉴权」");
    expect(comparison.deltaMs).toBe(0);
    const reverse = compareScenarios(afterSnapshot, beforeSnapshot);
    expect(reverse.changes.join(" ")).toContain("前置依赖 ＋「网关鉴权」");
  });
});
