import {
  VersionManager,
  deepClone,
  diffObjects,
  diffRules,
  ChangeType,
  RuleVersionSnapshot,
  RulesChangedEvent
} from '../index';
import { AlertRule, SimpleCondition, AggregateCondition } from '../../types';

function createSimpleRule(id: string, overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id,
    name: `Rule ${id}`,
    severity: 'warning',
    priority: 10,
    enabled: true,
    condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
    actions: [],
    ...overrides
  };
}

function createEvent(
  changeType: ChangeType,
  rulesBefore: AlertRule[],
  rulesAfter: AlertRule[],
  changedRuleIds: string[],
  operator: string = 'system',
  rollbackFromVersion?: number
): RulesChangedEvent {
  return {
    changeType,
    changedRuleIds,
    rulesBefore,
    rulesAfter,
    operator,
    rollbackFromVersion
  };
}

describe('deepClone', () => {
  it('should clone primitive values', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(true)).toBe(true);
    expect(deepClone(null)).toBe(null);
    expect(deepClone(undefined)).toBe(undefined);
  });

  it('should clone arrays deeply', () => {
    const arr = [{ a: 1 }, { b: 2 }];
    const cloned = deepClone(arr);
    expect(cloned).toEqual(arr);
    expect(cloned).not.toBe(arr);
    expect(cloned[0]).not.toBe(arr[0]);
  });

  it('should clone objects deeply', () => {
    const obj = { a: { b: { c: 1 } }, d: [1, 2, { e: 3 }] };
    const cloned = deepClone(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.a).not.toBe(obj.a);
    expect(cloned.a.b).not.toBe(obj.a.b);
    expect(cloned.d).not.toBe(obj.d);
    expect(cloned.d[2]).not.toBe(obj.d[2]);
  });

  it('should clone Dates', () => {
    const d = new Date(2024, 0, 1);
    const cloned = deepClone(d);
    expect(cloned).toEqual(d);
    expect(cloned).not.toBe(d);
  });

  it('should clone Maps', () => {
    const m = new Map<string, any>([['a', 1], ['b', { c: 2 }]]);
    const cloned = deepClone(m);
    expect(cloned).toEqual(m);
    expect(cloned).not.toBe(m);
    expect(cloned.get('b')).not.toBe(m.get('b'));
  });
});

describe('diffObjects', () => {
  it('should return empty array for identical objects', () => {
    const a = { x: 1, y: 'hello', z: true };
    expect(diffObjects(a, { ...a })).toEqual([]);
  });

  it('should detect simple field changes', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1, y: 3 };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'y', oldValue: 2, newValue: 3 });
    expect(changes.length).toBe(1);
  });

  it('should detect added fields', () => {
    const a = { x: 1 };
    const b = { x: 1, y: 2 };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'y', oldValue: null, newValue: 2 });
  });

  it('should detect removed fields', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 1 };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'y', oldValue: 2, newValue: null });
  });

  it('should treat null and missing fields as same', () => {
    const a = { x: null };
    const b = {};
    expect(diffObjects(a, b)).toEqual([]);
  });

  it('should ignore undefined fields', () => {
    const a = { x: undefined };
    const b = { x: 1 };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'x', oldValue: null, newValue: 1 });
  });

  it('should detect nested object changes with dot notation paths', () => {
    const a = { user: { name: 'Alice', age: 30 } };
    const b = { user: { name: 'Alice', age: 31 } };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'user.age', oldValue: 30, newValue: 31 });
  });

  it('should detect array changes by index', () => {
    const a = { items: [1, 2, 3] };
    const b = { items: [1, 5, 3] };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'items.1', oldValue: 2, newValue: 5 });
  });

  it('should detect deeply nested array element object changes', () => {
    const a = { actions: [{ type: 'webhook', url: 'http://a.com' }] };
    const b = { actions: [{ type: 'webhook', url: 'http://b.com' }] };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'actions.0.url', oldValue: 'http://a.com', newValue: 'http://b.com' });
  });

  it('should detect added array elements', () => {
    const a = { items: [1] };
    const b = { items: [1, 2] };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'items.1', oldValue: null, newValue: 2 });
  });

  it('should detect removed array elements', () => {
    const a = { items: [1, 2, 3] };
    const b = { items: [1, 2] };
    const changes = diffObjects(a, b);
    expect(changes).toContainEqual({ path: 'items.2', oldValue: 3, newValue: null });
  });

  it('should treat type-different values as different even if semantically same', () => {
    const a = { x: 100 };
    const b = { x: '100' };
    const changes = diffObjects(a, b);
    expect(changes.length).toBe(1);
    expect(changes[0].path).toBe('x');
  });
});

describe('diffRules', () => {
  it('should detect added rules', () => {
    const r1 = createSimpleRule('a');
    const r2 = createSimpleRule('b');
    const result = diffRules([r1], [r1, r2]);
    expect(result.added.map(r => r.id)).toEqual(['b']);
    expect(result.removed.length).toBe(0);
    expect(result.modified.length).toBe(0);
  });

  it('should detect removed rules', () => {
    const r1 = createSimpleRule('a');
    const r2 = createSimpleRule('b');
    const result = diffRules([r1, r2], [r1]);
    expect(result.removed.map(r => r.id)).toEqual(['b']);
    expect(result.added.length).toBe(0);
    expect(result.modified.length).toBe(0);
  });

  it('should detect modified rules with field changes', () => {
    const r1a = createSimpleRule('a', { name: 'Old Name' });
    const r1b = createSimpleRule('a', { name: 'New Name' });
    const result = diffRules([r1a], [r1b]);
    expect(result.modified.length).toBe(1);
    expect(result.modified[0].ruleId).toBe('a');
    expect(result.modified[0].changes).toContainEqual({
      path: 'name',
      oldValue: 'Old Name',
      newValue: 'New Name'
    });
  });

  it('should detect nested condition changes', () => {
    const r1 = createSimpleRule('a', {
      condition: {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 50,
        baseCondition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
        aggregation: 'count'
      } as AggregateCondition
    });
    const r2 = createSimpleRule('a', {
      condition: {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 100,
        baseCondition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
        aggregation: 'count'
      } as AggregateCondition
    });
    const result = diffRules([r1], [r2]);
    expect(result.modified.length).toBe(1);
    expect(result.modified[0].changes).toContainEqual({
      path: 'condition.threshold',
      oldValue: 50,
      newValue: 100
    });
  });
});

describe('VersionManager - snapshot creation and auto-increment', () => {
  it('should create snapshots with auto-incrementing version numbers', async () => {
    const vm = new VersionManager();
    const r1 = createSimpleRule('a');
    const r2 = createSimpleRule('a', { enabled: false });

    const s1 = await vm.createSnapshot(createEvent('create', [], [r1], ['a'], 'user1'));
    const s2 = await vm.createSnapshot(createEvent('disable', [r1], [r2], ['a'], 'user2'));

    expect(s1.version).toBe(1);
    expect(s2.version).toBe(2);
    expect(s1.timestamp).toBeLessThanOrEqual(s2.timestamp);
  });

  it('should store rules as deep copies so mutations do not affect snapshots', async () => {
    const vm = new VersionManager();
    const rule = createSimpleRule('a', { name: 'Original' });

    await vm.createSnapshot(createEvent('create', [], [rule], ['a']));
    rule.name = 'Mutated';

    const snapshot = vm.getVersion(1)!;
    expect(snapshot.rulesAfter[0].name).toBe('Original');
  });

  it('should capture operator correctly', async () => {
    const vm = new VersionManager();
    const r = createSimpleRule('a');

    const s1 = await vm.createSnapshot(createEvent('create', [], [r], ['a'], 'admin'));
    const s2 = await vm.createSnapshot(createEvent('reload', [r], [r], [], 'system'));

    expect(s1.operator).toBe('admin');
    expect(s2.operator).toBe('system');
  });

  it('should capture changeType correctly', async () => {
    const vm = new VersionManager();
    const r = createSimpleRule('a');
    const rEnabled = createSimpleRule('a', { enabled: true });
    const rDisabled = createSimpleRule('a', { enabled: false });

    const types: ChangeType[] = ['create', 'update', 'delete', 'enable', 'disable', 'reload', 'rollback'];
    for (const t of types) {
      await vm.createSnapshot(createEvent(t, [r], [r], ['a'], 'op'));
    }

    const list = vm.listVersions(1, 100).items;
    const storedTypes = list.map(i => i.changeType).sort();
    expect(storedTypes).toEqual([...types].sort());
  });
});

describe('VersionManager - 100 version eviction', () => {
  it('should evict oldest versions when exceeding 100', async () => {
    const vm = new VersionManager();
    const r = createSimpleRule('a');

    for (let i = 0; i < 150; i++) {
      await vm.createSnapshot(createEvent('update', [r], [r], ['a'], `op${i}`));
    }

    expect(vm.getVersionCount()).toBe(100);
    expect(vm.getVersion(1)).toBeUndefined();
    expect(vm.getVersion(50)).toBeUndefined();
    expect(vm.getVersion(51)).toBeDefined();
    expect(vm.getVersion(150)).toBeDefined();

    const latest = vm.getLatestVersion()!;
    expect(latest.version).toBe(150);
    expect(latest.operator).toBe('op149');
  });
});

describe('VersionManager - pagination', () => {
  let vm: VersionManager;
  let rules: AlertRule[];

  beforeEach(async () => {
    vm = new VersionManager();
    rules = [createSimpleRule('a')];
    for (let i = 0; i < 35; i++) {
      await vm.createSnapshot(createEvent('update', rules, rules, ['a'], `op${i}`));
    }
  });

  it('should return paginated results with correct defaults', () => {
    const result = vm.listVersions();
    expect(result.total).toBe(35);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.totalPages).toBe(2);
    expect(result.items.length).toBe(20);
  });

  it('should return items in descending order (newest first)', () => {
    const result = vm.listVersions(1, 10);
    expect(result.items[0].version).toBe(35);
    expect(result.items[9].version).toBe(26);
  });

  it('should handle page boundaries correctly', () => {
    const page2 = vm.listVersions(2, 20);
    expect(page2.page).toBe(2);
    expect(page2.items.length).toBe(15);
    expect(page2.items[0].version).toBe(15);
    expect(page2.items[14].version).toBe(1);
  });

  it('should clamp page to valid range', () => {
    const page0 = vm.listVersions(0, 20);
    expect(page0.page).toBe(1);

    const page99 = vm.listVersions(99, 20);
    expect(page99.page).toBe(2);
    expect(page99.items.length).toBe(15);
  });

  it('should support custom page_size', () => {
    const result = vm.listVersions(3, 10);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(4);
    expect(result.items.length).toBe(10);
    expect(result.items[0].version).toBe(15);
    expect(result.items[9].version).toBe(6);
  });
});

describe('VersionManager - diff versions', () => {
  let vm: VersionManager;
  let v1: RuleVersionSnapshot;
  let v2: RuleVersionSnapshot;

  beforeEach(async () => {
    vm = new VersionManager();
    const rA = createSimpleRule('a');
    const rB = createSimpleRule('b');
    v1 = await vm.createSnapshot(createEvent('create', [], [rA, rB], ['a', 'b'], 'admin'));

    const rADisabled = createSimpleRule('a', { enabled: false, name: 'Rule A Disabled' });
    const rC = createSimpleRule('c');
    v2 = await vm.createSnapshot(createEvent('update', [rA, rB], [rADisabled, rC], ['a', 'b', 'c'], 'admin'));
  });

  it('should return null for non-existent versions', () => {
    expect(vm.diffVersions(1, 999)).toBeNull();
    expect(vm.diffVersions(999, 2)).toBeNull();
  });

  it('should correctly compute diff between two versions', () => {
    const diff = vm.diffVersions(v1.version, v2.version)!;
    expect(diff).not.toBeNull();

    expect(diff.added.map(r => r.id)).toEqual(['c']);
    expect(diff.removed.map(r => r.id)).toEqual(['b']);
    expect(diff.modified.map(m => m.ruleId)).toEqual(['a']);

    const modA = diff.modified.find(m => m.ruleId === 'a')!;
    expect(modA.changes.length).toBeGreaterThanOrEqual(2);
    expect(modA.changes).toContainEqual({
      path: 'name',
      oldValue: 'Rule a',
      newValue: 'Rule A Disabled'
    });
    expect(modA.changes).toContainEqual({
      path: 'enabled',
      oldValue: true,
      newValue: false
    });
  });
});

describe('VersionManager - concurrent version monotonically increasing', () => {
  it('should produce strictly increasing versions under concurrent snapshot creation', async () => {
    const vm = new VersionManager();
    const r = createSimpleRule('a');

    const promises: Promise<RuleVersionSnapshot>[] = [];
    const CONCURRENCY = 50;
    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(vm.createSnapshot(createEvent('update', [r], [r], ['a'], `op${i}`)));
    }

    const snapshots = await Promise.all(promises);
    const versions = snapshots.map(s => s.version).sort((a, b) => a - b);

    expect(versions.length).toBe(CONCURRENCY);
    expect(versions[0]).toBe(1);
    expect(versions[CONCURRENCY - 1]).toBe(CONCURRENCY);

    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBe(versions[i - 1] + 1);
    }
  });
});
