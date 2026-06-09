import { Condition, SimpleCondition, CompositeCondition, AggregateCondition, SequenceCondition, StructuredLog, ComparisonOperator } from '../types';

export interface ConditionMatchResult {
  matched: boolean;
  extractedFields?: Record<string, any>;
  matchedLogs?: StructuredLog[];
}

export function evaluateCondition(
  condition: Condition,
  log: StructuredLog,
  engineContext?: EngineContext
): ConditionMatchResult {
  switch (condition.type) {
    case 'simple':
      return evaluateSimpleCondition(condition, log);
    case 'composite':
      return evaluateCompositeCondition(condition, log, engineContext);
    case 'aggregate':
      return { matched: false };
    case 'sequence':
      return { matched: false };
    default:
      return { matched: false };
  }
}

interface EngineContext {
  now?: number;
}

function evaluateSimpleCondition(
  cond: SimpleCondition,
  log: StructuredLog
): ConditionMatchResult {
  const fieldValue = getFieldValue(log, cond.field);
  const matched = compareValues(fieldValue, cond.operator, cond.value);
  return { matched };
}

function evaluateCompositeCondition(
  cond: CompositeCondition,
  log: StructuredLog,
  ctx?: EngineContext
): ConditionMatchResult {
  if (cond.operator === 'NOT') {
    const inner = cond.conditions[0];
    if (!inner) return { matched: false };
    const result = evaluateCondition(inner, log, ctx);
    return { matched: !result.matched };
  }

  if (cond.operator === 'AND') {
    for (const c of cond.conditions) {
      const result = evaluateCondition(c, log, ctx);
      if (!result.matched) return { matched: false };
    }
    return { matched: true };
  }

  if (cond.operator === 'OR') {
    for (const c of cond.conditions) {
      const result = evaluateCondition(c, log, ctx);
      if (result.matched) return { matched: true };
    }
    return { matched: false };
  }

  return { matched: false };
}

function getFieldValue(log: StructuredLog, fieldPath: string): any {
  if (fieldPath === 'timestamp') return log.timestamp;
  if (fieldPath === 'level') return log.level;
  if (fieldPath === 'source') return log.source;
  if (fieldPath === 'message') return log.message;
  if (fieldPath === 'raw') return log.raw;

  let effectivePath = fieldPath;
  if (effectivePath.startsWith('fields.')) {
    effectivePath = effectivePath.substring(7);
  }

  const parts = effectivePath.split('.');
  let current: any = log.fields;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function compareValues(
  left: any,
  op: ComparisonOperator,
  right: any
): boolean {
  const isNumeric = (v: any) => v !== null && v !== undefined && v !== '' && (typeof v === 'number' || (typeof v === 'string' && !isNaN(parseFloat(v)) && isFinite(v as any)));
  const toNum = (v: any) => typeof v === 'number' ? v : parseFloat(v);

  switch (op) {
    case '==':
      return looseEqual(left, right);
    case '!=':
      return !looseEqual(left, right);
    case '>':
      if (isNumeric(left) && isNumeric(right)) return toNum(left) > toNum(right);
      return String(left) > String(right);
    case '<':
      if (isNumeric(left) && isNumeric(right)) return toNum(left) < toNum(right);
      return String(left) < String(right);
    case '>=':
      if (isNumeric(left) && isNumeric(right)) return toNum(left) >= toNum(right);
      return String(left) >= String(right);
    case '<=':
      if (isNumeric(left) && isNumeric(right)) return toNum(left) <= toNum(right);
      return String(left) <= String(right);
    case 'contains':
      return String(left ?? '').includes(String(right));
    case 'not_contains':
      return !String(left ?? '').includes(String(right));
    case 'matches':
      try {
        const re = typeof right === 'string' ? new RegExp(right) : right as RegExp;
        return re.test(String(left ?? ''));
      } catch {
        return false;
      }
    case 'not_matches':
      try {
        const re = typeof right === 'string' ? new RegExp(right) : right as RegExp;
        return !re.test(String(left ?? ''));
      } catch {
        return true;
      }
    case 'in':
      const arr = Array.isArray(right) ? right : [right];
      return arr.some(v => looseEqual(left, v));
    case 'not_in':
      const arr2 = Array.isArray(right) ? right : [right];
      return !arr2.some(v => looseEqual(left, v));
    default:
      return false;
  }
}

function looseEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'string') return a === parseFloat(b);
  if (typeof a === 'string' && typeof b === 'number') return parseFloat(a) === b;
  return String(a) === String(b);
}
