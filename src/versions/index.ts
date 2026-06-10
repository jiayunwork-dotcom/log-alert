import { EventEmitter } from 'events';
import { AlertRule } from '../types';

export type ChangeType = 'reload' | 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'rollback' | 'batch' | 'patch';

export interface RuleVersionSnapshot {
  version: number;
  timestamp: number;
  changeType: ChangeType;
  changedRuleIds: string[];
  rulesBefore: AlertRule[];
  rulesAfter: AlertRule[];
  operator: string;
  rollbackFromVersion?: number;
}

export interface VersionSummary {
  version: number;
  timestamp: number;
  changeType: ChangeType;
  changedRuleCount: number;
  operator: string;
  rollbackFromVersion?: number;
}

export interface FieldDiff {
  path: string;
  oldValue: any;
  newValue: any;
}

export interface RuleDiff {
  added: AlertRule[];
  removed: AlertRule[];
  modified: Array<{
    ruleId: string;
    rule: AlertRule;
    changes: FieldDiff[];
  }>;
}

export interface RulesChangedEvent {
  changeType: ChangeType;
  changedRuleIds: string[];
  rulesBefore: AlertRule[];
  rulesAfter: AlertRule[];
  operator: string;
  rollbackFromVersion?: number;
}

export interface PagedResult<T> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  items: T[];
}

export interface RollbackResult {
  success: boolean;
  restoredRuleCount: number;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
  newVersion: number;
}

export interface VersionTag {
  name: string;
  version: number;
  description?: string;
  createdAt: number;
  createdBy: string;
}

export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string;
}

export type DiffFormat = 'json' | 'text' | 'patch';

export interface BatchOperation {
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable';
  ruleId?: string;
  rule?: any;
  changes?: any;
}

export interface BatchOperationResult {
  action: string;
  ruleId?: string;
  success: boolean;
  error?: string;
  rule?: any;
}

export interface BatchValidationError {
  index: number;
  action: string;
  errors: string[];
}

export interface BatchExecuteResult {
  success: boolean;
  results: BatchOperationResult[];
  rulesBefore: AlertRule[];
  rulesAfter: AlertRule[];
  changedRuleIds: string[];
  validationErrors?: BatchValidationError[];
}

const MAX_VERSIONS = 100;
const MAX_TAGS = 100;

export function deepClone<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date) return new Date(obj.getTime()) as any;
  if (obj instanceof Map) return new Map(Array.from(obj.entries()).map(([k, v]) => [k, deepClone(v)])) as any;
  if (obj instanceof Set) return new Set(Array.from(obj).map(v => deepClone(v))) as any;
  if (Array.isArray(obj)) return obj.map(item => deepClone(item)) as any;
  const cloned: any = {};
  for (const key of Object.keys(obj as any)) {
    cloned[key] = deepClone((obj as any)[key]);
  }
  return cloned as T;
}

export function diffObjects(oldObj: any, newObj: any, basePath: string = ''): FieldDiff[] {
  const changes: FieldDiff[] = [];

  const isDefined = (v: any) => v !== undefined;
  const isNullish = (v: any) => v === null || v === undefined;

  const allKeys = new Set<string>();
  if (oldObj && typeof oldObj === 'object') {
    for (const k of Object.keys(oldObj)) {
      if (isDefined(oldObj[k])) allKeys.add(k);
    }
  }
  if (newObj && typeof newObj === 'object') {
    for (const k of Object.keys(newObj)) {
      if (isDefined(newObj[k])) allKeys.add(k);
    }
  }

  for (const key of Array.from(allKeys)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const oldVal = oldObj ? oldObj[key] : undefined;
    const newVal = newObj ? newObj[key] : undefined;

    if (isNullish(oldVal) && isNullish(newVal)) {
      continue;
    }

    if (oldVal === newVal) {
      continue;
    }

    if (typeof oldVal === 'object' && typeof newVal === 'object' &&
        oldVal !== null && newVal !== null &&
        !Array.isArray(oldVal) && !Array.isArray(newVal)) {
      changes.push(...diffObjects(oldVal, newVal, path));
      continue;
    }

    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      const maxLen = Math.max(oldVal.length, newVal.length);
      for (let i = 0; i < maxLen; i++) {
        const idxPath = `${path}.${i}`;
        const ov = oldVal[i];
        const nv = newVal[i];

        if (isNullish(ov) && isNullish(nv)) continue;
        if (ov === nv) continue;

        if (typeof ov === 'object' && typeof nv === 'object' &&
            ov !== null && nv !== null &&
            !Array.isArray(ov) && !Array.isArray(nv)) {
          changes.push(...diffObjects(ov, nv, idxPath));
        } else if (Array.isArray(ov) && Array.isArray(nv)) {
          changes.push(...diffObjects(ov, nv, idxPath));
        } else {
          changes.push({ path: idxPath, oldValue: isDefined(ov) ? ov : null, newValue: isDefined(nv) ? nv : null });
        }
      }
      continue;
    }

    changes.push({
      path,
      oldValue: isDefined(oldVal) ? oldVal : null,
      newValue: isDefined(newVal) ? newVal : null
    });
  }

  return changes;
}

export function diffRules(rulesV1: AlertRule[], rulesV2: AlertRule[]): RuleDiff {
  const result: RuleDiff = { added: [], removed: [], modified: [] };

  const v1Map = new Map<string, AlertRule>();
  const v2Map = new Map<string, AlertRule>();

  for (const r of rulesV1) v1Map.set(r.id, r);
  for (const r of rulesV2) v2Map.set(r.id, r);

  for (const [id, rule] of v2Map) {
    if (!v1Map.has(id)) {
      result.added.push(rule);
    }
  }

  for (const [id, rule] of v1Map) {
    if (!v2Map.has(id)) {
      result.removed.push(rule);
    }
  }

  for (const [id, ruleV2] of v2Map) {
    if (v1Map.has(id)) {
      const ruleV1 = v1Map.get(id)!;
      const changes = diffObjects(ruleV1, ruleV2);
      if (changes.length > 0) {
        result.modified.push({ ruleId: id, rule: ruleV2, changes });
      }
    }
  }

  return result;
}

export function diffToJsonPatch(rulesV1: AlertRule[], rulesV2: AlertRule[]): JsonPatchOperation[] {
  const patches: JsonPatchOperation[] = [];
  const v1Map = new Map<string, AlertRule>();
  const v2Map = new Map<string, AlertRule>();

  for (const r of rulesV1) v1Map.set(r.id, r);
  for (const r of rulesV2) v2Map.set(r.id, r);

  let v1Index = 0;
  for (const rule of rulesV1) {
    if (!v2Map.has(rule.id)) {
      patches.push({ op: 'remove', path: `/rules/${v1Index}` });
    } else {
      v1Index++;
    }
  }

  for (const rule of rulesV2) {
    if (!v1Map.has(rule.id)) {
      const v1Rules = rulesV1.filter(r => v2Map.has(r.id));
      const insertIndex = v1Rules.length;
      patches.push({ op: 'add', path: `/rules/${insertIndex}`, value: deepClone(rule) });
    } else {
      const oldRule = v1Map.get(rule.id)!;
      const changes = diffObjects(oldRule, rule);
      if (changes.length > 0) {
        const idx = rulesV1.findIndex(r => r.id === rule.id);
        for (const change of changes) {
          const path = `/rules/${idx}/${change.path.replace(/\./g, '/')}`;
          if (change.oldValue === null && change.newValue !== null) {
            patches.push({ op: 'add', path, value: deepClone(change.newValue) });
          } else if (change.oldValue !== null && change.newValue === null) {
            patches.push({ op: 'remove', path });
          } else {
            patches.push({ op: 'replace', path, value: deepClone(change.newValue) });
          }
        }
      }
    }
  }

  return patches;
}

function getByPath(obj: any, path: string): any {
  const parts = path.split('/').filter(p => p !== '');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      current = current[idx];
    } else {
      current = current[part];
    }
  }
  return current;
}

function setByPath(obj: any, path: string, value: any, op: 'add' | 'replace' = 'add'): void {
  const parts = path.split('/').filter(p => p !== '');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      current = current[idx];
    } else {
      if (!current[part]) current[part] = {};
      current = current[part];
    }
  }
  const lastPart = parts[parts.length - 1];
  if (Array.isArray(current)) {
    const idx = parseInt(lastPart, 10);
    if (op === 'add') {
      if (idx >= current.length) {
        current.push(value);
      } else {
        current.splice(idx, 0, value);
      }
    } else {
      if (idx >= current.length) {
        current.push(value);
      } else {
        current[idx] = value;
      }
    }
  } else {
    current[lastPart] = value;
  }
}

function removeByPath(obj: any, path: string): void {
  const parts = path.split('/').filter(p => p !== '');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      current = current[idx];
    } else {
      current = current[part];
    }
  }
  const lastPart = parts[parts.length - 1];
  if (Array.isArray(current)) {
    const idx = parseInt(lastPart, 10);
    current.splice(idx, 1);
  } else {
    delete current[lastPart];
  }
}

export function applyJsonPatch(rules: AlertRule[], patch: JsonPatchOperation[]): AlertRule[] {
  const result = { rules: deepClone(rules) };

  for (const op of patch) {
    switch (op.op) {
      case 'add':
        setByPath(result, op.path, deepClone(op.value), 'add');
        break;
      case 'remove':
        removeByPath(result, op.path);
        break;
      case 'replace':
        setByPath(result, op.path, deepClone(op.value), 'replace');
        break;
      case 'copy':
        if (op.from !== undefined) {
          const value = getByPath(result, op.from);
          setByPath(result, op.path, deepClone(value), 'add');
        }
        break;
      case 'move':
        if (op.from !== undefined) {
          const value = getByPath(result, op.from);
          removeByPath(result, op.from);
          setByPath(result, op.path, deepClone(value), 'add');
        }
        break;
      case 'test':
        const actual = getByPath(result, op.path);
        if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
          throw new Error(`Test operation failed at path ${op.path}`);
        }
        break;
    }
  }

  return result.rules;
}

export function formatDiffAsText(diff: RuleDiff): string {
  const lines: string[] = [];
  const addedCount = diff.added.length;
  const removedCount = diff.removed.length;
  const modifiedCount = diff.modified.length;
  const total = addedCount + removedCount + modifiedCount;

  lines.push(`Diff summary: ${total} rule(s) changed (${addedCount} added, ${removedCount} removed, ${modifiedCount} modified)`);
  lines.push('');

  if (diff.added.length > 0) {
    lines.push('Added rules:');
    for (const rule of diff.added) {
      lines.push(`  + ${rule.id} (${rule.name}) [severity: ${rule.severity}]`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('Removed rules:');
    for (const rule of diff.removed) {
      lines.push(`  - ${rule.id} (${rule.name}) [severity: ${rule.severity}]`);
    }
    lines.push('');
  }

  if (diff.modified.length > 0) {
    lines.push('Modified rules:');
    for (const mod of diff.modified) {
      const fieldCount = mod.changes.length;
      const fields = mod.changes.map(c => c.path).join(', ');
      lines.push(`  ~ ${mod.ruleId} (${mod.rule.name}): ${fieldCount} field(s) changed [${fields}]`);
    }
    lines.push('');
  }

  const stats: string[] = [];
  if (addedCount > 0) stats.push(`${addedCount} addition(s)`);
  if (removedCount > 0) stats.push(`${removedCount} deletion(s)`);
  if (modifiedCount > 0) {
    const totalFieldChanges = diff.modified.reduce((sum, m) => sum + m.changes.length, 0);
    stats.push(`${totalFieldChanges} modification(s) across ${modifiedCount} rule(s)`);
  }
  if (stats.length > 0) {
    lines.push(stats.join(', '));
  }

  return lines.join('\n');
}

export function validateCondition(condition: any): string[] {
  const errors: string[] = [];

  if (!condition || typeof condition !== 'object') {
    errors.push('condition must be an object');
    return errors;
  }

  const type = condition.type || 'simple';

  switch (type) {
    case 'simple':
      if (!condition.field) errors.push('condition.field is required');
      if (!condition.operator) errors.push('condition.operator is required');
      if (!('value' in condition)) errors.push('condition.value is required');
      break;
    case 'composite':
      if (!condition.operator) errors.push('condition.operator is required');
      if (!Array.isArray(condition.conditions)) {
        errors.push('condition.conditions must be an array');
      } else if (condition.conditions.length === 0) {
        errors.push('condition.conditions must not be empty');
      } else {
        for (let i = 0; i < condition.conditions.length; i++) {
          const subErrors = validateCondition(condition.conditions[i]);
          for (const err of subErrors) {
            errors.push(`conditions[${i}].${err}`);
          }
        }
      }
      break;
    case 'aggregate':
      if (!condition.windowSeconds || condition.windowSeconds <= 0) {
        errors.push('condition.windowSeconds must be a positive number');
      }
      if (condition.threshold === undefined || condition.threshold === null) {
        errors.push('condition.threshold is required');
      }
      if (!condition.baseCondition) {
        errors.push('condition.baseCondition is required');
      } else {
        const baseErrors = validateCondition(condition.baseCondition);
        for (const err of baseErrors) {
          errors.push(`baseCondition.${err}`);
        }
      }
      break;
    case 'sequence':
      if (!condition.keyField) errors.push('condition.keyField is required');
      if (!Array.isArray(condition.events) || condition.events.length === 0) {
        errors.push('condition.events must be a non-empty array');
      } else {
        for (let i = 0; i < condition.events.length; i++) {
          const event = condition.events[i];
          if (!event.eventId) errors.push(`events[${i}].eventId is required`);
          if (!event.condition) {
            errors.push(`events[${i}].condition is required`);
          } else {
            const eventErrors = validateCondition(event.condition);
            for (const err of eventErrors) {
              errors.push(`events[${i}].condition.${err}`);
            }
          }
        }
      }
      if (!condition.maxTotalSeconds || condition.maxTotalSeconds <= 0) {
        errors.push('condition.maxTotalSeconds must be a positive number');
      }
      break;
    default:
      errors.push(`unknown condition type: ${type}`);
  }

  return errors;
}

export class VersionManager extends EventEmitter {
  private tags: VersionTag[] = [];
  private snapshots: RuleVersionSnapshot[] = [];
  private nextVersion: number = 1;
  private versionLock: Promise<void> = Promise.resolve();

  constructor() {
    super();
  }

  private async acquireLock(): Promise<() => void> {
    const prevLock = this.versionLock;
    let release: () => void = () => {};
    this.versionLock = prevLock.then(() => new Promise<void>(resolve => { release = resolve; }));
    await prevLock;
    return release;
  }

  async createSnapshot(event: RulesChangedEvent): Promise<RuleVersionSnapshot> {
    const release = await this.acquireLock();
    try {
      const version = this.nextVersion++;
      const snapshot: RuleVersionSnapshot = {
        version,
        timestamp: Date.now(),
        changeType: event.changeType,
        changedRuleIds: [...event.changedRuleIds],
        rulesBefore: deepClone(event.rulesBefore),
        rulesAfter: deepClone(event.rulesAfter),
        operator: event.operator,
        rollbackFromVersion: event.rollbackFromVersion
      };

      this.snapshots.push(snapshot);

      while (this.snapshots.length > MAX_VERSIONS) {
        this.snapshots.shift();
      }

      this.emit('snapshotCreated', snapshot);
      return snapshot;
    } finally {
      release();
    }
  }

  listVersions(page: number = 1, pageSize: number = 20): PagedResult<VersionSummary> {
    const total = this.snapshots.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const start = (safePage - 1) * pageSize;

    const items = this.snapshots
      .slice()
      .reverse()
      .slice(start, start + pageSize)
      .map(s => ({
        version: s.version,
        timestamp: s.timestamp,
        changeType: s.changeType,
        changedRuleCount: s.changedRuleIds.length,
        operator: s.operator,
        rollbackFromVersion: s.rollbackFromVersion
      }));

    return {
      total,
      page: safePage,
      pageSize,
      totalPages,
      items
    };
  }

  getVersion(version: number): RuleVersionSnapshot | undefined {
    return this.snapshots.find(s => s.version === version);
  }

  getLatestVersion(): RuleVersionSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  getVersionCount(): number {
    return this.snapshots.length;
  }

  diffVersions(v1: number, v2: number): RuleDiff | null {
    const snap1 = this.getVersion(v1);
    const snap2 = this.getVersion(v2);
    if (!snap1 || !snap2) return null;
    return diffRules(snap1.rulesAfter, snap2.rulesAfter);
  }

  diffVersionsFormatted(v1: number, v2: number, format: DiffFormat = 'json'): any {
    const snap1 = this.getVersion(v1);
    const snap2 = this.getVersion(v2);
    if (!snap1 || !snap2) return null;

    const diff = diffRules(snap1.rulesAfter, snap2.rulesAfter);

    switch (format) {
      case 'json':
        return { v1, v2, diff };
      case 'text':
        return formatDiffAsText(diff);
      case 'patch':
        return { v1, v2, patch: diffToJsonPatch(snap1.rulesAfter, snap2.rulesAfter) };
      default:
        return { v1, v2, diff };
    }
  }

  createTag(version: number, name: string, description: string | undefined, createdBy: string): VersionTag | null {
    const snap = this.getVersion(version);
    if (!snap) return null;

    if (this.tags.some(t => t.name === name)) {
      return null;
    }

    const tag: VersionTag = {
      name,
      version,
      description,
      createdAt: Date.now(),
      createdBy
    };

    this.tags.push(tag);

    while (this.tags.length > MAX_TAGS) {
      this.tags.shift();
    }

    return tag;
  }

  deleteTag(name: string): boolean {
    const idx = this.tags.findIndex(t => t.name === name);
    if (idx === -1) return false;
    this.tags.splice(idx, 1);
    return true;
  }

  getTag(name: string): VersionTag | undefined {
    return this.tags.find(t => t.name === name);
  }

  listTags(): VersionTag[] {
    return [...this.tags];
  }

  getVersionByTag(tagName: string): RuleVersionSnapshot | undefined {
    const tag = this.getTag(tagName);
    if (!tag) return undefined;
    return this.getVersion(tag.version);
  }
}
