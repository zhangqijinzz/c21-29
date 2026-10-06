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
import { tidyDependencies } from "../src/features/graph-editor/graphViewModel";
import { simulateProject } from "../src/shared/domain/simulation";
import { EXAMPLE_PROJECT, type RequestNode } from "../src/shared/domain/types";

function hygieneNode(
  id: string,
  name: string,
  dependencyIds: string[],
): RequestNode {
  return {
    id,
    name,
    durationMs: 100,
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
    scenarios: [],
    nodes: [
      hygieneNode("a", "分段A", []),
      hygieneNode("b", "分段B", ["a"]),
      hygieneNode("c", "分段C", ["a", "b"]),
      hygieneNode("d", "分段D", ["e"]),
      hygieneNode("e", "分段E", []),
    ],
  };
}

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

  it("keeps saved snapshots intact when dependencies are tidied", () => {
    const project = hygieneProject();
    const saved = saveScenario(project, simulateProject(project), "整理前");
    const snapshot = saved.scenarios[0];
    if (!snapshot) throw new Error("Scenario fixture should be saved");
    const snapshotNodes = structuredClone(snapshot.nodes);
    const outcome = tidyDependencies(saved);
    expect(outcome.project.scenarios).toBe(saved.scenarios);
    expect(outcome.project.scenarios[0]?.nodes).toEqual(snapshotNodes);
    expect(snapshot.nodes.find((node) => node.id === "c")?.dependencyIds).toEqual(
      ["a", "b"],
    );
  });

  it("describes dependency changes between pre and post tidy snapshots", () => {
    const project = hygieneProject();
    const baseline = saveScenario(
      project,
      simulateProject(project),
      "整理前",
    ).scenarios[0];
    const tidied = tidyDependencies(project).project;
    const comparison = saveScenario(
      tidied,
      simulateProject(tidied),
      "整理后",
    ).scenarios[0];
    if (!baseline || !comparison)
      throw new Error("Scenario fixtures should be saved");
    const result = compareScenarios(baseline, comparison);
    const changes = result.changes.join(" ");
    expect(changes).toContain("分段C · 移除前置「分段A」");
    expect(changes).toContain("分段D · 移除前置「分段E」");
    expect(changes).toContain("分段E · 新增前置「分段D」");
    expect(result.deltaMs).toBe(0);
  });
});
