import { EventEmitter } from 'events';
import { AlertRule } from '../types';

export type ChangeType = 'reload' | 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'rollback';

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

const MAX_VERSIONS = 100;

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

export class VersionManager extends EventEmitter {
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
}
