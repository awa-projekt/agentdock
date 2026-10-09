import type { Node } from '@xyflow/react';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_NODE_WIDTH = 256;
const DEFAULT_NODE_HEIGHT = 148;
const DEFAULT_NODE_GAP = 28;
const DEFAULT_PASSES = 6;
const RELEASE_REPEL_ANIMATION_MS = 260;
const RELEASE_REPEL_CLASS_NAME = 'graph-node-settling';

type Position = { readonly x: number; readonly y: number };

type ReleaseRepelOptions<TNode extends Node> = {
  readonly nodes: ReadonlyArray<TNode>;
  readonly setNodes: Dispatch<SetStateAction<Array<TNode>>>;
  readonly enabled: boolean;
  readonly settleAllKey?: string;
  readonly onDragStart?: () => void;
  readonly onNodesSettled?: (nodes: ReadonlyArray<TNode>) => void;
};

const nodeSize = (node: Node) => ({
  width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
  height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
});

const samePosition = (left: Position, right: Position): boolean => left.x === right.x && left.y === right.y;

const slidOffPosition = <TNode extends Node>(nodes: ReadonlyArray<TNode>, draggedNode: TNode): Position => {
  const draggedSize = nodeSize(draggedNode);
  let position = { ...draggedNode.position };

  for (let pass = 0; pass < DEFAULT_PASSES; pass += 1) {
    let moved = false;

    for (const other of nodes) {
      if (other.id === draggedNode.id) continue;

      const otherSize = nodeSize(other);
      const draggedCenter = { x: position.x + draggedSize.width / 2, y: position.y + draggedSize.height / 2 };
      const otherCenter = { x: other.position.x + otherSize.width / 2, y: other.position.y + otherSize.height / 2 };
      const delta = { x: draggedCenter.x - otherCenter.x, y: draggedCenter.y - otherCenter.y };
      const minDistance = {
        x: (draggedSize.width + otherSize.width) / 2 + DEFAULT_NODE_GAP,
        y: (draggedSize.height + otherSize.height) / 2 + DEFAULT_NODE_GAP,
      };
      const overlap = { x: minDistance.x - Math.abs(delta.x), y: minDistance.y - Math.abs(delta.y) };

      if (overlap.x <= 0 || overlap.y <= 0) continue;

      const axis = overlap.x < overlap.y ? 'x' : 'y';
      const direction = delta[axis] === 0 ? (draggedNode.id < other.id ? 1 : -1) : Math.sign(delta[axis]);
      position =
        axis === 'x'
          ? { x: position.x + (overlap.x + 1) * direction, y: position.y }
          : { x: position.x, y: position.y + (overlap.y + 1) * direction };
      moved = true;
    }

    if (!moved) break;
  }

  return position;
};

const slidOffPositions = <TNode extends Node>(nodes: ReadonlyArray<TNode>): ReadonlyArray<TNode> => {
  let nextNodes = [...nodes];

  for (const node of nodes) {
    nextNodes = nextNodes.map((candidate) =>
      candidate.id === node.id ? { ...candidate, position: slidOffPosition(nextNodes, candidate) } : candidate,
    );
  }

  return nextNodes;
};

export const useReleaseRepel = <TNode extends Node>({
  nodes,
  setNodes,
  enabled,
  settleAllKey,
  onDragStart,
  onNodesSettled,
}: ReleaseRepelOptions<TNode>) => {
  const [settlingNodeIds, setSettlingNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const settlingFiber = useRef<Fiber.Fiber<void> | null>(null);
  const lastSettleAllKey = useRef<string | null>(null);

  const clearSettling = useCallback(() => {
    if (settlingFiber.current) Effect.runFork(Fiber.interrupt(settlingFiber.current));
    settlingFiber.current = null;
    setSettlingNodeIds(new Set());
  }, []);

  const scheduleSettled = useCallback(() => {
    settlingFiber.current = Effect.runFork(
      Effect.delay(
        Effect.sync(() => setSettlingNodeIds(new Set())),
        RELEASE_REPEL_ANIMATION_MS,
      ),
    );
  }, []);

  useEffect(() => clearSettling, [clearSettling]);

  const onNodeDragStart = useCallback(() => {
    clearSettling();
    onDragStart?.();
  }, [clearSettling, onDragStart]);

  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, draggedNode: TNode) => {
      const draggedCurrentNode = nodes.find((node) => node.id === draggedNode.id) ?? draggedNode;
      const baseDraggedNode = { ...draggedCurrentNode, position: draggedNode.position };
      const finalPosition = enabled ? slidOffPosition(nodes, baseDraggedNode) : draggedNode.position;
      const shouldAnimate = enabled && !samePosition(finalPosition, draggedNode.position);

      if (shouldAnimate) {
        clearSettling();
        setSettlingNodeIds(new Set([draggedNode.id]));
        scheduleSettled();
      }

      const nextNodes = nodes.map((node) => (node.id === draggedNode.id ? { ...node, position: finalPosition } : node));
      setNodes(nextNodes);
      onNodesSettled?.(nextNodes);
    },
    [clearSettling, enabled, nodes, onNodesSettled, scheduleSettled, setNodes],
  );

  useEffect(() => {
    if (!enabled) {
      lastSettleAllKey.current = null;
      return;
    }

    if (!settleAllKey || lastSettleAllKey.current === settleAllKey) {
      return;
    }

    lastSettleAllKey.current = settleAllKey;
    const nextNodes = slidOffPositions(nodes);
    const movedNodeIds = nextNodes
      .filter((node, index) => !samePosition(node.position, nodes[index]?.position ?? node.position))
      .map((node) => node.id);

    if (movedNodeIds.length === 0) {
      return;
    }

    clearSettling();
    setSettlingNodeIds(new Set(movedNodeIds));
    scheduleSettled();
    setNodes([...nextNodes]);
    onNodesSettled?.(nextNodes);
  }, [clearSettling, enabled, nodes, onNodesSettled, scheduleSettled, setNodes, settleAllKey]);

  const flowNodes = useMemo(
    () =>
      nodes.map((node) =>
        settlingNodeIds.has(node.id)
          ? { ...node, className: [node.className, RELEASE_REPEL_CLASS_NAME].filter(Boolean).join(' ') }
          : node,
      ),
    [nodes, settlingNodeIds],
  );

  return { flowNodes, onNodeDragStart, onNodeDragStop };
};
