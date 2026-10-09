import type { ESTree } from '@oxlint/plugins';
import * as Predicate from 'effect/Predicate';

type ExpressionWrapper =
  | ESTree.ChainExpression
  | ESTree.ParenthesizedExpression
  | ESTree.TSNonNullExpression
  | ESTree.TSAsExpression
  | ESTree.TSTypeAssertion;

const isExpressionWrapper = (node: ESTree.Node): node is ExpressionWrapper =>
  node.type === 'ChainExpression' ||
  node.type === 'ParenthesizedExpression' ||
  node.type === 'TSNonNullExpression' ||
  node.type === 'TSAsExpression' ||
  node.type === 'TSTypeAssertion';

export const unwrapExpression = (node: ESTree.Node): ESTree.Node => {
  let current = node;
  while (isExpressionWrapper(current)) current = current.expression;
  return current;
};

const propertyName = (node: ESTree.Node): string | undefined => {
  switch (node.type) {
    case 'Identifier':
    case 'PrivateIdentifier':
      return node.name;
    case 'Literal':
      return Predicate.isString(node.value) ? node.value : undefined;
    default:
      return undefined;
  }
};

export interface MemberCallee {
  readonly object: string;
  readonly method: string;
}

/** `Object.method` for a callee like `Schema.decodeSync` or `Effect.runPromise`, seen through wrappers. */
export const memberCallee = (callee: ESTree.Node): MemberCallee | undefined => {
  const expression = unwrapExpression(callee);
  if (expression.type !== 'MemberExpression' || !('property' in expression)) return undefined;
  const object = unwrapExpression(expression.object);
  if (object.type !== 'Identifier') return undefined;
  const method = propertyName(expression.property);
  return method === undefined ? undefined : { object: object.name, method };
};
