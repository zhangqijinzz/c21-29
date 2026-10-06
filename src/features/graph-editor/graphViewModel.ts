import { analyzeGraph, updateNode } from "../../shared/domain/graph";
import type { GraphAnalysis } from "../../shared/domain/graph";
import type { LatencyProject, RequestNode } from "../../shared/domain/types";

export type EditableNodeField =
  | "name"
  | "durationMs"
  | "jitterMs"
  | "timeoutMs"
  | "retryCount"
  | "failureRate";

export function getGraphAnalysis(project: LatencyProject): GraphAnalysis {
  return analyzeGraph(project);
}

export function addRequestNode(project: LatencyProject): LatencyProject {
  const index = project.nodes.length + 1;
  const node: RequestNode = {
    id: crypto.randomUUID(),
    name: `请求节点 ${index}`,
    durationMs: 400,
    jitterMs: 80,
    dependencyIds: [],
    timeoutMs: 1200,
    retryCount: 0,
    failureRate: 0,
  };
  return { ...project, nodes: [...project.nodes, node], updatedAt: Date.now() };
}

export function patchRequestNode(
  project: LatencyProject,
  id: string,
  patch: Partial<RequestNode>,
): LatencyProject {
  return {
    ...project,
    nodes: updateNode(project.nodes, id, patch),
    updatedAt: Date.now(),
  };
}

export function removeRequestNode(
  project: LatencyProject,
  id: string,
): LatencyProject {
  return {
    ...project,
    nodes: project.nodes
      .filter((node) => node.id !== id)
      .map((node) => ({
        ...node,
        dependencyIds: node.dependencyIds.filter(
          (dependencyId) => dependencyId !== id,
        ),
        fallbackNodeId:
          node.fallbackNodeId === id ? undefined : node.fallbackNodeId,
      })),
    updatedAt: Date.now(),
  };
}

export function toggleDependency(
  project: LatencyProject,
  nodeId: string,
  dependencyId: string,
): { project: LatencyProject; error?: string } {
  if (nodeId === dependencyId) return { project, error: "节点不能依赖自身" };
  const node = project.nodes.find((item) => item.id === nodeId);
  if (!node) return { project, error: "没有找到当前节点" };
  const dependencyIds = node.dependencyIds.includes(dependencyId)
    ? node.dependencyIds.filter((id) => id !== dependencyId)
    : [...node.dependencyIds, dependencyId];
  const next = {
    ...project,
    nodes: updateNode(project.nodes, nodeId, { dependencyIds }),
    updatedAt: Date.now(),
  };
  const cycle = analyzeGraph(next).cycle;
  return cycle.length
    ? { project, error: "这条连线会形成循环依赖，已撤销" }
    : { project: next };
}

export function setConcurrency(
  project: LatencyProject,
  value: number | null,
): LatencyProject {
  return { ...project, concurrencyLimit: value, updatedAt: Date.now() };
}

export interface TidyChange {
  kind: "removed" | "reversed";
  nodeId: string;
  dependencyId: string;
  summary: string;
}

export interface TidySkip {
  nodeId: string;
  dependencyId: string;
  reason: string;
}

export interface TidyOutcome {
  project: LatencyProject;
  changes: TidyChange[];
  skipped: TidySkip[];
}

function reachableFrom(
  dependencies: Map<string, string[]>,
  fromId: string,
): Set<string> {
  const visited = new Set<string>();
  const stack = [...(dependencies.get(fromId) ?? [])];
  while (stack.length) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const next of dependencies.get(id) ?? []) stack.push(next);
  }
  return visited;
}

function formsCycle(
  project: LatencyProject,
  dependencies: Map<string, string[]>,
): boolean {
  return (
    analyzeGraph({
      ...project,
      nodes: project.nodes.map((node) => ({
        ...node,
        dependencyIds: dependencies.get(node.id) ?? [],
      })),
    }).cycle.length > 0
  );
}

/**
 * 依赖整理：作为一个整体动作，一次性反转顺序冲突、归约多余连线。
 * 只重写 nodes 的依赖关系，不触碰 scenarios 等历史快照。
 */
export function tidyDependencies(project: LatencyProject): TidyOutcome {
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const orderIndex = new Map(
    project.nodes.map((node, index) => [node.id, index]),
  );
  const dependencies = new Map(
    project.nodes.map((node) => [node.id, [...node.dependencyIds]]),
  );
  const changes: TidyChange[] = [];
  const skipped: TidySkip[] = [];
  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  // 顺序冲突：把与分段推进顺序相反的连线反转到一致
  for (const node of project.nodes) {
    for (const dependencyId of node.dependencyIds) {
      if (!byId.has(dependencyId) || dependencyId === node.id) continue;
      if ((orderIndex.get(dependencyId) ?? 0) <= (orderIndex.get(node.id) ?? 0))
        continue;
      const current = dependencies.get(node.id) ?? [];
      if (!current.includes(dependencyId)) continue;
      const via = current.find(
        (other) =>
          other !== dependencyId &&
          reachableFrom(dependencies, other).has(dependencyId),
      );
      if (via) continue; // 多余连线交给归约阶段移除
      const dependencyDeps = dependencies.get(dependencyId) ?? [];
      if (dependencyDeps.includes(node.id)) {
        skipped.push({
          nodeId: node.id,
          dependencyId,
          reason: `「${nameOf(dependencyId)}」已依赖「${nameOf(node.id)}」，保留原连线`,
        });
        continue;
      }
      dependencies.set(
        node.id,
        current.filter((id) => id !== dependencyId),
      );
      dependencies.set(dependencyId, [...dependencyDeps, node.id]);
      if (formsCycle(project, dependencies)) {
        dependencies.set(node.id, current);
        dependencies.set(dependencyId, dependencyDeps);
        skipped.push({
          nodeId: node.id,
          dependencyId,
          reason: `「${nameOf(node.id)}」→「${nameOf(dependencyId)}」反转后会形成循环，保留原连线`,
        });
      } else {
        changes.push({
          kind: "reversed",
          nodeId: node.id,
          dependencyId,
          summary: `反转顺序冲突：「${nameOf(dependencyId)}」改为依赖「${nameOf(node.id)}」`,
        });
      }
    }
  }

  // 多余连线：已间接可达的直连做传递归约
  for (const node of project.nodes) {
    for (const dependencyId of [...(dependencies.get(node.id) ?? [])]) {
      const current = dependencies.get(node.id) ?? [];
      const via = current.find(
        (other) =>
          other !== dependencyId &&
          reachableFrom(dependencies, other).has(dependencyId),
      );
      if (!via) continue;
      dependencies.set(
        node.id,
        current.filter((id) => id !== dependencyId),
      );
      changes.push({
        kind: "removed",
        nodeId: node.id,
        dependencyId,
        summary: `移除多余连线：「${nameOf(node.id)}」已经由「${nameOf(via)}」间接依赖「${nameOf(dependencyId)}」`,
      });
    }
  }

  if (!changes.length) return { project, changes, skipped };
  return {
    project: {
      ...project,
      nodes: project.nodes.map((node) => {
        const next = dependencies.get(node.id) ?? [];
        return next.join("|") === node.dependencyIds.join("|")
          ? node
          : { ...node, dependencyIds: next };
      }),
      updatedAt: Date.now(),
    },
    changes,
    skipped,
  };
}
