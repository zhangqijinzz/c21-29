import type { LatencyProject, RequestNode, ValidationResult } from "./types";

export interface DependencyIssue {
  kind: "redundant" | "order";
  nodeId: string;
  dependencyId: string;
  message: string;
}

export interface GraphAnalysis {
  order: string[];
  cycle: string[];
  validation: ValidationResult;
  dependencyIssues: DependencyIssue[];
}

export interface DependencyTidyResult {
  nodes: RequestNode[];
  removedEdges: { nodeId: string; dependencyId: string }[];
  movedCount: number;
}

export function analyzeGraph(project: LatencyProject): GraphAnalysis {
  const nodeIds = new Set(project.nodes.map((node) => node.id));
  const incoming = new Map(project.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(
    project.nodes.map((node) => [node.id, [] as string[]]),
  );
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const node of project.nodes) {
    if (!node.name.trim()) errors.push(`${node.id}: 节点名称不能为空`);
    if (node.durationMs < 0 || !Number.isFinite(node.durationMs))
      errors.push(`${node.name}: 耗时必须大于等于 0`);
    if (node.jitterMs < 0 || !Number.isFinite(node.jitterMs))
      errors.push(`${node.name}: 波动范围必须大于等于 0`);
    if (node.timeoutMs < 0 || !Number.isFinite(node.timeoutMs))
      errors.push(`${node.name}: 超时必须大于等于 0`);
    if (
      !Number.isInteger(node.retryCount) ||
      node.retryCount < 0 ||
      node.retryCount > 8
    )
      errors.push(`${node.name}: 重试次数需在 0–8 次`);
    if (node.failureRate < 0 || node.failureRate > 100)
      errors.push(`${node.name}: 失败概率需在 0–100%`);
    if (node.retryCount > 3)
      warnings.push(`${node.name}: 重试次数较高，可能放大尾延迟`);
    for (const dependencyId of node.dependencyIds) {
      if (!nodeIds.has(dependencyId)) {
        errors.push(`${node.name}: 前置节点不存在`);
        continue;
      }
      if (dependencyId === node.id) {
        errors.push(`${node.name}: 不能依赖自身`);
        continue;
      }
      incoming.set(node.id, (incoming.get(node.id) ?? 0) + 1);
      outgoing.get(dependencyId)?.push(node.id);
    }
    if (node.fallbackNodeId) {
      if (!nodeIds.has(node.fallbackNodeId))
        errors.push(`${node.name}: 降级目标不存在`);
      if (node.fallbackNodeId === node.id)
        errors.push(`${node.name}: 降级目标不能是自身`);
    }
  }

  const ready = project.nodes
    .filter((node) => incoming.get(node.id) === 0)
    .map((node) => node.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift();
    if (!id) break;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const degree = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, degree);
      if (degree === 0) ready.push(next);
    }
  }

  const cycle: string[] = [];
  if (order.length !== project.nodes.length) {
    const color = new Map(project.nodes.map((node) => [node.id, 0]));
    const stack: string[] = [];
    const visit = (id: string): boolean => {
      color.set(id, 1);
      stack.push(id);
      const node = project.nodes.find((item) => item.id === id);
      for (const dependencyId of node?.dependencyIds ?? []) {
        if (!nodeIds.has(dependencyId)) continue;
        const dependencyColor = color.get(dependencyId) ?? 0;
        if (dependencyColor === 1) {
          const start = stack.indexOf(dependencyId);
          cycle.push(...stack.slice(start), dependencyId);
          return true;
        }
        if (dependencyColor === 0 && visit(dependencyId)) return true;
      }
      stack.pop();
      color.set(id, 2);
      return false;
    };
    for (const node of project.nodes) {
      if ((color.get(node.id) ?? 0) === 0 && visit(node.id)) break;
    }
  }
  if (cycle.length)
    errors.push(
      `检测到循环依赖：${cycle.map((id) => project.nodes.find((node) => node.id === id)?.name ?? id).join(" → ")}`,
    );

  const dependencyIssues: DependencyIssue[] = [];
  if (!cycle.length) {
    const byId = new Map(project.nodes.map((node) => [node.id, node]));
    const position = new Map(
      project.nodes.map((node, index) => [node.id, index]),
    );
    const nameOf = (id: string) => byId.get(id)?.name ?? id;
    const findIndirectPath = (
      startIds: string[],
      targetId: string,
    ): string[] => {
      const visited = new Set<string>();
      const queue = startIds.map((id) => ({ id, path: [id] }));
      while (queue.length) {
        const current = queue.shift();
        if (!current) break;
        if (current.id === targetId) return current.path;
        if (visited.has(current.id)) continue;
        visited.add(current.id);
        for (const next of byId.get(current.id)?.dependencyIds ?? []) {
          if (byId.has(next) && !visited.has(next))
            queue.push({ id: next, path: [...current.path, next] });
        }
      }
      return [];
    };
    for (const node of project.nodes) {
      for (const dependencyId of node.dependencyIds) {
        if (!nodeIds.has(dependencyId) || dependencyId === node.id) continue;
        const others = node.dependencyIds.filter(
          (id) => id !== dependencyId && nodeIds.has(id) && id !== node.id,
        );
        const indirect = others.length
          ? findIndirectPath(others, dependencyId)
          : [];
        if (indirect.length) {
          const chain = indirect.map((id) => `「${nameOf(id)}」`).join(" → ");
          dependencyIssues.push({
            kind: "redundant",
            nodeId: node.id,
            dependencyId,
            message: `「${node.name}」对「${nameOf(dependencyId)}」的直连依赖多余：已能沿 ${chain} 间接到达`,
          });
          continue;
        }
        if ((position.get(dependencyId) ?? 0) > (position.get(node.id) ?? 0)) {
          dependencyIssues.push({
            kind: "order",
            nodeId: node.id,
            dependencyId,
            message: `「${node.name}」依赖了分段顺序更靠后的「${nameOf(dependencyId)}」，推演顺序将与分段先后相反`,
          });
        }
      }
    }
    for (const issue of dependencyIssues) warnings.push(issue.message);
  }
  if (
    project.nodes.some((node) => node.dependencyIds.length === 0) &&
    project.nodes.length > 1
  ) {
    warnings.push("多个入口节点会同时开始；并发上限可能让部分入口排队");
  }
  return { order, cycle, validation: { errors, warnings }, dependencyIssues };
}

export function tidyDependencies(
  project: LatencyProject,
): DependencyTidyResult {
  const analysis = analyzeGraph(project);
  if (analysis.validation.errors.length)
    return { nodes: project.nodes, removedEdges: [], movedCount: 0 };
  const removedByNode = new Map<string, Set<string>>();
  const removedEdges: { nodeId: string; dependencyId: string }[] = [];
  for (const issue of analysis.dependencyIssues) {
    if (issue.kind !== "redundant") continue;
    const set = removedByNode.get(issue.nodeId) ?? new Set<string>();
    set.add(issue.dependencyId);
    removedByNode.set(issue.nodeId, set);
    removedEdges.push({
      nodeId: issue.nodeId,
      dependencyId: issue.dependencyId,
    });
  }
  const pruned = project.nodes.map((node) => ({
    ...node,
    dependencyIds: node.dependencyIds.filter(
      (id) => !removedByNode.get(node.id)?.has(id),
    ),
  }));
  const prunedOrder = analyzeGraph({ ...project, nodes: pruned }).order;
  const byId = new Map(pruned.map((node) => [node.id, node]));
  const sorted = prunedOrder
    .map((id) => byId.get(id))
    .filter((node): node is RequestNode => Boolean(node));
  const movedCount = sorted.filter(
    (node, index) => project.nodes[index]?.id !== node.id,
  ).length;
  return { nodes: sorted, removedEdges, movedCount };
}

export function updateNode(
  nodes: RequestNode[],
  id: string,
  patch: Partial<RequestNode>,
): RequestNode[] {
  return nodes.map((node) => (node.id === id ? { ...node, ...patch } : node));
}
