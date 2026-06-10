import {
  VersionManager,
  deepClone,
  diffRules,
  diffToJsonPatch,
  applyJsonPatch,
  formatDiffAsText,
  validateCondition,
  ChangeType,
  RuleVersionSnapshot,
  RulesChangedEvent,
  JsonPatchOperation
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

describe('validateCondition', () => {
  it('should validate simple conditions correctly', () => {
    expect(validateCondition({ type: 'simple', field: 'level', operator: '==', value: 'ERROR' })).toEqual([]);
    expect(validateCondition({ field: 'level', operator: '==', value: 'ERROR' })).toEqual([]);
  });

  it('should detect missing fields in simple conditions', () => {
    const errors = validateCondition({ type: 'simple' } as any);
    expect(errors).toContain('condition.field is required');
    expect(errors).toContain('condition.operator is required');
    expect(errors).toContain('condition.value is required');
  });

  it('should validate composite conditions', () => {
    const valid = {
      type: 'composite' as const,
      operator: 'AND' as const,
      conditions: [
        { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
        { type: 'simple', field: 'source', operator: '==', value: 'app' }
      ]
    };
    expect(validateCondition(valid)).toEqual([]);
  });

  it('should detect invalid composite conditions', () => {
    const errors = validateCondition({ type: 'composite' } as any);
    expect(errors).toContain('condition.operator is required');
    expect(errors).toContain('condition.conditions must be an array');
  });

  it('should validate aggregate conditions', () => {
    const valid = {
      type: 'aggregate' as const,
      windowSeconds: 60,
      threshold: 5,
      baseCondition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
      aggregation: 'count' as const
    };
    expect(validateCondition(valid)).toEqual([]);
  });

  it('should detect invalid aggregate conditions', () => {
    const errors = validateCondition({ type: 'aggregate', windowSeconds: 60, threshold: 5 } as any);
    expect(errors).toContain('condition.baseCondition is required');
  });

  it('should validate sequence conditions', () => {
    const valid = {
      type: 'sequence' as const,
      keyField: 'request_id',
      maxTotalSeconds: 60,
      events: [
        { eventId: 'start', condition: { type: 'simple', field: 'event', operator: '==', value: 'start' }, timeoutSeconds: 30 },
        { eventId: 'end', condition: { type: 'simple', field: 'event', operator: '==', value: 'end' }, timeoutSeconds: 30 }
      ]
    };
    expect(validateCondition(valid)).toEqual([]);
  });

  it('should reject unknown condition types', () => {
    const errors = validateCondition({ type: 'invalid' } as any);
    expect(errors).toContain('unknown condition type: invalid');
  });
});

describe('JSON Patch - diffToJsonPatch and applyJsonPatch', () => {
  it('should generate patch for added rules', () => {
    const rulesV1: AlertRule[] = [];
    const rulesV2 = [createSimpleRule('a')];
    const patch = diffToJsonPatch(rulesV1, rulesV2);

    expect(patch.length).toBeGreaterThan(0);
    expect(patch.some(p => p.op === 'add')).toBe(true);
  });

  it('should generate patch for removed rules', () => {
    const rulesV1 = [createSimpleRule('a')];
    const rulesV2: AlertRule[] = [];
    const patch = diffToJsonPatch(rulesV1, rulesV2);

    expect(patch.length).toBeGreaterThan(0);
    expect(patch.some(p => p.op === 'remove')).toBe(true);
  });

  it('should generate patch for modified rules', () => {
    const rulesV1 = [createSimpleRule('a', { name: 'Old Name' })];
    const rulesV2 = [createSimpleRule('a', { name: 'New Name' })];
    const patch = diffToJsonPatch(rulesV1, rulesV2);

    expect(patch.length).toBeGreaterThan(0);
    expect(patch.some(p => p.op === 'replace')).toBe(true);
  });

  it('round-trip: apply patch to v1 should produce v2 rules', () => {
    const rulesV1 = [
      createSimpleRule('a', { name: 'Rule A', priority: 10 }),
      createSimpleRule('b', { name: 'Rule B' })
    ];
    const rulesV2 = [
      createSimpleRule('a', { name: 'Updated Rule A', priority: 20 }),
      createSimpleRule('c', { name: 'Rule C' })
    ];

    const patch = diffToJsonPatch(rulesV1, rulesV2);
    const applied = applyJsonPatch(rulesV1, patch);

    expect(applied.length).toBe(rulesV2.length);
    const appliedMap = new Map(applied.map(r => [r.id, r]));
    const v2Map = new Map(rulesV2.map(r => [r.id, r]));

    for (const [id, v2Rule] of v2Map) {
      expect(appliedMap.has(id)).toBe(true);
      const appliedRule = appliedMap.get(id)!;
      expect(appliedRule.name).toBe(v2Rule.name);
      expect(appliedRule.priority).toBe(v2Rule.priority);
    }
  });

  it('should handle empty diff (identical rules)', () => {
    const rules = [createSimpleRule('a')];
    const patch = diffToJsonPatch(rules, rules);
    const applied = applyJsonPatch(rules, patch);
    expect(applied).toEqual(rules);
  });

  it('should support move operation within array', () => {
    const rules = [
      createSimpleRule('a'),
      createSimpleRule('b'),
      createSimpleRule('c')
    ];
    const patch: JsonPatchOperation[] = [
      { op: 'move', from: '/rules/0', path: '/rules/3' }
    ];
    const result = applyJsonPatch(rules, patch);
    expect(result.length).toBe(3);
    expect(result[0].id).toBe('b');
    expect(result[1].id).toBe('c');
    expect(result[2].id).toBe('a');
  });

  it('should support copy operation', () => {
    const rules = [createSimpleRule('a')];
    const patch: JsonPatchOperation[] = [
      { op: 'copy', from: '/rules/0', path: '/rules/1' }
    ];
    const result = applyJsonPatch(rules, patch);
    expect(result.length).toBe(2);
    expect(result[1].name).toBe(result[0].name);
  });

  it('should support test operation', () => {
    const rules = [createSimpleRule('a', { name: 'Test Rule' })];
    const patch: JsonPatchOperation[] = [
      { op: 'test', path: '/rules/0/name', value: 'Test Rule' }
    ];
    expect(() => applyJsonPatch(rules, patch)).not.toThrow();
  });

  it('should throw on failed test operation', () => {
    const rules = [createSimpleRule('a')];
    const patch: JsonPatchOperation[] = [
      { op: 'test', path: '/rules/0/name', value: 'Wrong Name' }
    ];
    expect(() => applyJsonPatch(rules, patch)).toThrow();
  });
});

describe('formatDiffAsText', () => {
  it('should format diff as human-readable text', () => {
    const rulesV1 = [
      createSimpleRule('a', { name: 'Rule A' }),
      createSimpleRule('b', { name: 'Rule B' })
    ];
    const rulesV2 = [
      createSimpleRule('a', { name: 'Updated Rule A', priority: 20 }),
      createSimpleRule('c', { name: 'Rule C' })
    ];

    const diff = diffRules(rulesV1, rulesV2);
    const text = formatDiffAsText(diff);

    expect(typeof text).toBe('string');
    expect(text).toContain('Diff summary:');
    expect(text).toContain('added');
    expect(text).toContain('removed');
    expect(text).toContain('modified');
    expect(text).toContain('Rule C');
    expect(text).toContain('Rule B');
    expect(text).toContain('Updated Rule A');
  });

  it('should handle empty diff gracefully', () => {
    const diff = diffRules([], []);
    const text = formatDiffAsText(diff);
    expect(text).toContain('0 rule(s) changed');
  });

  it('should include added rules with + prefix', () => {
    const diff = diffRules([], [createSimpleRule('a')]);
    const text = formatDiffAsText(diff);
    expect(text).toContain('+ a');
  });

  it('should include removed rules with - prefix', () => {
    const diff = diffRules([createSimpleRule('a')], []);
    const text = formatDiffAsText(diff);
    expect(text).toContain('- a');
  });

  it('should include modified rules with ~ prefix', () => {
    const diff = diffRules(
      [createSimpleRule('a', { name: 'Old' })],
      [createSimpleRule('a', { name: 'New' })]
    );
    const text = formatDiffAsText(diff);
    expect(text).toContain('~ a');
  });
});

describe('VersionManager - diffVersionsFormatted', () => {
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

  it('should return json format by default', () => {
    const result = vm.diffVersionsFormatted(v1.version, v2.version, 'json');
    expect(result).not.toBeNull();
    expect(result.v1).toBe(v1.version);
    expect(result.v2).toBe(v2.version);
    expect(result.diff).toBeDefined();
    expect(result.diff.added).toBeDefined();
    expect(result.diff.removed).toBeDefined();
    expect(result.diff.modified).toBeDefined();
  });

  it('should return text format', () => {
    const result = vm.diffVersionsFormatted(v1.version, v2.version, 'text');
    expect(typeof result).toBe('string');
    expect(result).toContain('Diff summary:');
  });

  it('should return patch format', () => {
    const result = vm.diffVersionsFormatted(v1.version, v2.version, 'patch');
    expect(result).not.toBeNull();
    expect(result.v1).toBe(v1.version);
    expect(result.v2).toBe(v2.version);
    expect(Array.isArray(result.patch)).toBe(true);
    expect(result.patch.length).toBeGreaterThan(0);
  });

  it('should return null for non-existent versions', () => {
    expect(vm.diffVersionsFormatted(1, 999, 'json')).toBeNull();
    expect(vm.diffVersionsFormatted(999, 2, 'json')).toBeNull();
  });

  it('patch format round-trip: apply patch to v1 rules should equal v2 rules', () => {
    const result = vm.diffVersionsFormatted(v1.version, v2.version, 'patch');
    const patch = result.patch;
    const applied = applyJsonPatch(v1.rulesAfter, patch);

    const v2Map = new Map(v2.rulesAfter.map(r => [r.id, r]));
    const appliedMap = new Map(applied.map(r => [r.id, r]));

    expect(appliedMap.size).toBe(v2Map.size);
    for (const [id, v2Rule] of v2Map) {
      expect(appliedMap.has(id)).toBe(true);
      const appliedRule = appliedMap.get(id)!;
      expect(appliedRule.name).toBe(v2Rule.name);
      expect(appliedRule.enabled).toBe(v2Rule.enabled);
    }
  });
});

describe('VersionManager - tags', () => {
  let vm: VersionManager;
  let v1: RuleVersionSnapshot;
  let v2: RuleVersionSnapshot;

  beforeEach(async () => {
    vm = new VersionManager();
    v1 = await vm.createSnapshot(createEvent('create', [], [createSimpleRule('a')], ['a'], 'admin'));
    v2 = await vm.createSnapshot(createEvent('update', [createSimpleRule('a')], [createSimpleRule('a', { name: 'Updated' })], ['a'], 'admin'));
  });

  it('should create a tag', () => {
    const tag = vm.createTag(v1.version, 'v1.0', 'Production release', 'admin');
    expect(tag).not.toBeNull();
    expect(tag!.name).toBe('v1.0');
    expect(tag!.version).toBe(v1.version);
    expect(tag!.description).toBe('Production release');
    expect(tag!.createdBy).toBe('admin');
    expect(tag!.createdAt).toBeGreaterThan(0);
  });

  it('should return null when creating tag for non-existent version', () => {
    const tag = vm.createTag(999, 'invalid', '', 'admin');
    expect(tag).toBeNull();
  });

  it('should enforce unique tag names (return null for duplicate)', () => {
    const tag1 = vm.createTag(v1.version, 'v1.0', 'First tag', 'admin');
    expect(tag1).not.toBeNull();

    const tag2 = vm.createTag(v2.version, 'v1.0', 'Duplicate', 'admin');
    expect(tag2).toBeNull();
  });

  it('should list all tags', () => {
    vm.createTag(v1.version, 'tag1', '', 'admin');
    vm.createTag(v2.version, 'tag2', '', 'admin');

    const tags = vm.listTags();
    expect(tags.length).toBe(2);
    expect(tags.map(t => t.name).sort()).toEqual(['tag1', 'tag2']);
  });

  it('should get a tag by name', () => {
    vm.createTag(v1.version, 'mytag', 'My Tag', 'admin');
    const tag = vm.getTag('mytag');
    expect(tag).not.toBeUndefined();
    expect(tag!.name).toBe('mytag');
    expect(tag!.description).toBe('My Tag');
  });

  it('should return undefined for non-existent tag', () => {
    expect(vm.getTag('nonexistent')).toBeUndefined();
  });

  it('should delete a tag', () => {
    vm.createTag(v1.version, 'deleteme', '', 'admin');
    expect(vm.getTag('deleteme')).not.toBeUndefined();

    const result = vm.deleteTag('deleteme');
    expect(result).toBe(true);
    expect(vm.getTag('deleteme')).toBeUndefined();
  });

  it('should return false when deleting non-existent tag', () => {
    const result = vm.deleteTag('nonexistent');
    expect(result).toBe(false);
  });

  it('should get version by tag name', () => {
    vm.createTag(v1.version, 'v1.0', '', 'admin');
    const snapshot = vm.getVersionByTag('v1.0');
    expect(snapshot).not.toBeUndefined();
    expect(snapshot!.version).toBe(v1.version);
  });

  it('should return undefined for non-existent tag in getVersionByTag', () => {
    expect(vm.getVersionByTag('nonexistent')).toBeUndefined();
  });

  it('should respect MAX_TAGS limit', () => {
    for (let i = 0; i < 150; i++) {
      vm.createTag(v1.version, `tag${i}`, '', 'admin');
    }
    expect(vm.listTags().length).toBeLessThanOrEqual(100);
  });
});

describe('VersionManager - batch and patch change types', () => {
  it('should support batch change type', async () => {
    const vm = new VersionManager();
    const snapshot = await vm.createSnapshot(createEvent(
      'batch',
      [createSimpleRule('a')],
      [createSimpleRule('a'), createSimpleRule('b')],
      ['a', 'b'],
      'admin'
    ));
    expect(snapshot.changeType).toBe('batch');
    expect(snapshot.changedRuleIds.sort()).toEqual(['a', 'b']);
  });

  it('should support patch change type', async () => {
    const vm = new VersionManager();
    const snapshot = await vm.createSnapshot(createEvent(
      'patch',
      [createSimpleRule('a')],
      [createSimpleRule('a', { name: 'Patched' })],
      ['a'],
      'admin'
    ));
    expect(snapshot.changeType).toBe('patch');
  });

  it('should list batch and patch change types correctly', async () => {
    const vm = new VersionManager();
    await vm.createSnapshot(createEvent('batch', [], [createSimpleRule('a')], ['a'], 'op'));
    await vm.createSnapshot(createEvent('patch', [createSimpleRule('a')], [createSimpleRule('b')], ['a', 'b'], 'op'));

    const items = vm.listVersions(1, 10).items;
    const types = items.map(i => i.changeType);
    expect(types).toContain('batch');
    expect(types).toContain('patch');
  });
});
