import { AlertRuleEngine } from '../../engine';
import { AlertRule, SimpleCondition, AggregateCondition, StructuredLog } from '../../types';
import { RuleManager } from '../../rules';
import { OutputDispatcher } from '../../outputs';
import { TemplateEngine } from '../../templates';
import { createAppRuntime, AppRuntime, rollbackToVersion, applyPatch, rollbackByTag } from '../../app/runtime';
import { AppConfig } from '../../types';
import { VersionManager, deepClone, RulesChangedEvent, BatchOperation, diffToJsonPatch, applyJsonPatch, BatchExecuteResult } from '..';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

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

function createLog(overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp: Date.now(),
    level: 'ERROR',
    source: 'test',
    message: 'test error',
    fields: {},
    raw: '',
    ...overrides
  };
}

function createTempRuleFile(rules: AlertRule[]): string {
  const rawRules = rules.map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    severity: r.severity,
    priority: r.priority,
    enabled: r.enabled,
    condition: convertConditionToRaw(r.condition),
    actions: r.actions,
    cooldown_seconds: r.cooldownSeconds,
    depends_on: r.dependsOn,
    escalation: r.escalation ? {
      to_severity: r.escalation.toSeverity,
      after_seconds: r.escalation.afterSeconds
    } : undefined,
    recovery_notification: r.recoveryNotification,
    dedup: r.dedup ? {
      window_seconds: r.dedup.windowSeconds,
      hash_prefix_length: r.dedup.hashPrefixLength
    } : undefined,
    top_n: r.topN ? {
      window_seconds: r.topN.windowSeconds,
      n: r.topN.n,
      field: r.topN.field
    } : undefined
  }));
  const content = yaml.dump(rawRules);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-alert-test-'));
  const filePath = path.join(tmpDir, 'rules.yaml');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function convertConditionToRaw(cond: any): any {
  if (cond.type === 'composite') {
    return {
      type: cond.type,
      operator: cond.operator,
      conditions: cond.conditions.map(convertConditionToRaw)
    };
  } else if (cond.type === 'aggregate') {
    return {
      type: cond.type,
      window_seconds: cond.windowSeconds,
      slide_seconds: cond.slideSeconds,
      threshold: cond.threshold,
      group_by: cond.groupBy,
      base_condition: convertConditionToRaw(cond.baseCondition),
      aggregation: cond.aggregation,
      aggregate_field: cond.aggregateField
    };
  } else if (cond.type === 'sequence') {
    return {
      type: cond.type,
      key_field: cond.keyField,
      events: cond.events.map((e: any) => ({
        event_id: e.eventId,
        condition: convertConditionToRaw(e.condition),
        timeout_seconds: e.timeoutSeconds
      })),
      max_total_seconds: cond.maxTotalSeconds
    };
  } else {
    return {
      type: cond.type || 'simple',
      field: cond.field,
      operator: cond.operator,
      value: cond.value
    };
  }
}

describe('RuleManager - batch operations validation', () => {
  let engine: AlertRuleEngine;
  let outputDispatcher: OutputDispatcher;
  let ruleManager: RuleManager;

  beforeEach(() => {
    engine = new AlertRuleEngine();
    const templateEngine = new TemplateEngine({});
    outputDispatcher = new OutputDispatcher({ dryRun: true, templateEngine });
    ruleManager = new RuleManager(engine, outputDispatcher, { dryRun: true });
  });

  it('should validate batch operations and return errors for invalid operations', async () => {
    await ruleManager.loadRuleFiles([]);

    const existingRule = createSimpleRule('existing');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const operations: BatchOperation[] = [
      { action: 'create', rule: { id: '', name: '', severity: 'invalid' } },
      { action: 'update', ruleId: 'nonexistent', changes: { name: 'test' } },
      { action: 'delete', ruleId: 'nonexistent' },
      { action: 'enable', ruleId: 'nonexistent' }
    ];

    const errors = ruleManager.validateBatchOperations(operations);

    expect(errors.length).toBe(4);
    expect(errors[0].index).toBe(0);
    expect(errors[0].action).toBe('create');
    expect(errors[0].errors.length).toBeGreaterThan(0);

    expect(errors[1].index).toBe(1);
    expect(errors[1].action).toBe('update');
    expect(errors[1].errors).toContain('rule with id "nonexistent" not found');

    expect(errors[2].index).toBe(2);
    expect(errors[2].action).toBe('delete');

    expect(errors[3].index).toBe(3);
    expect(errors[3].action).toBe('enable');
  });

  it('should detect duplicate rule id in create operation', async () => {
    await ruleManager.loadRuleFiles([]);

    const existingRule = createSimpleRule('duplicate-id');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('duplicate-id') }
    ];

    const errors = ruleManager.validateBatchOperations(operations);
    expect(errors.length).toBe(1);
    expect(errors[0].errors).toContain('rule with id "duplicate-id" already exists');
  });

  it('should return empty errors for valid operations', async () => {
    await ruleManager.loadRuleFiles([]);

    const existingRule = createSimpleRule('existing');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('new-rule') },
      { action: 'update', ruleId: 'existing', changes: { name: 'Updated' } },
      { action: 'disable', ruleId: 'existing' }
    ];

    const errors = ruleManager.validateBatchOperations(operations);
    expect(errors.length).toBe(0);
  });

  it('should validate condition format in create and update', async () => {
    await ruleManager.loadRuleFiles([]);

    const operations: BatchOperation[] = [
      {
        action: 'create',
        rule: {
          id: 'bad-condition',
          name: 'Bad Rule',
          severity: 'warning',
          condition: { type: 'invalid_type' }
        }
      }
    ];

    const errors = ruleManager.validateBatchOperations(operations);
    expect(errors.length).toBe(1);
    expect(errors[0].errors.some(e => e.includes('condition'))).toBe(true);
  });
});

describe('RuleManager - batch execution with transaction', () => {
  let engine: AlertRuleEngine;
  let outputDispatcher: OutputDispatcher;
  let ruleManager: RuleManager;
  let events: any[];

  beforeEach(() => {
    engine = new AlertRuleEngine();
    const templateEngine = new TemplateEngine({});
    outputDispatcher = new OutputDispatcher({ dryRun: true, templateEngine });
    ruleManager = new RuleManager(engine, outputDispatcher, { dryRun: true });
    events = [];
    ruleManager.onRulesChanged(e => events.push(e));
  });

  it('should execute all operations successfully in a batch', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const ruleA = createSimpleRule('rule-a');
    const ruleB = createSimpleRule('rule-b', { enabled: true });
    engine.addRule(ruleA);
    engine.addRule(ruleB);
    (ruleManager as any).rules = [ruleA, ruleB];

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('rule-c') },
      { action: 'update', ruleId: 'rule-a', changes: { name: 'Updated Rule A', priority: 5 } },
      { action: 'disable', ruleId: 'rule-b' }
    ];

    const result = await ruleManager.executeBatch(operations, 'test-operator');

    expect(result.success).toBe(true);
    expect(result.results.length).toBe(3);
    expect(result.results.every(r => r.success)).toBe(true);
    expect(result.changedRuleIds.sort()).toEqual(['rule-a', 'rule-b', 'rule-c']);

    const ruleAResult = ruleManager.getRule('rule-a');
    const ruleBResult = ruleManager.getRule('rule-b');
    const ruleCResult = ruleManager.getRule('rule-c');
    expect(ruleAResult).not.toBeUndefined();
    expect(ruleAResult!.name).toBe('Updated Rule A');
    expect(ruleAResult!.priority).toBe(5);
    expect(ruleBResult).not.toBeUndefined();
    expect(ruleBResult!.enabled).toBe(false);
    expect(ruleCResult).not.toBeUndefined();
    expect(ruleCResult!.enabled).toBe(true);
  });

  it('should emit only one rulesChanged event with changeType "batch"', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const existingRule = createSimpleRule('rule-a');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('rule-b') },
      { action: 'create', rule: createSimpleRule('rule-c') },
      { action: 'update', ruleId: 'rule-a', changes: { name: 'Updated' } }
    ];

    await ruleManager.executeBatch(operations, 'test-operator');

    expect(events.length).toBe(1);
    expect(events[0].changeType).toBe('batch');
    expect(events[0].operator).toBe('test-operator');
    expect(events[0].changedRuleIds.sort()).toEqual(['rule-a', 'rule-b', 'rule-c']);
  });

  it('should not execute any operations if pre-validation fails', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const existingRule = createSimpleRule('rule-a');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('valid-rule') },
      { action: 'update', ruleId: 'nonexistent', changes: { name: 'test' } },
      { action: 'create', rule: createSimpleRule('another-valid') }
    ];

    const result = await ruleManager.executeBatch(operations, 'test-operator');

    expect(result.success).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.length).toBe(1);
    expect(result.validationErrors![0].index).toBe(1);

    expect(ruleManager.getRule('valid-rule')).toBeUndefined();
    expect(ruleManager.getRule('another-valid')).toBeUndefined();
    expect(ruleManager.getRules().length).toBe(1);
    expect(events.length).toBe(0);
  });

  it('should rollback all operations if execution fails mid-way', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const existingRule = createSimpleRule('rule-a');
    engine.addRule(existingRule);
    (ruleManager as any).rules = [existingRule];

    const originalRules = deepClone(ruleManager.getRules());

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('rule-b') },
      { action: 'create', rule: createSimpleRule('rule-c') }
    ];

    const originalRemoveRule = engine.removeRule.bind(engine);
    let failCount = 0;
    engine.removeRule = (id: string) => {
      failCount++;
      if (failCount >= 1) {
        throw new Error('Simulated failure during execution');
      }
      return originalRemoveRule(id);
    };

    const operationsWithDelete: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('rule-b') },
      { action: 'delete', ruleId: 'rule-a' }
    ];

    const result = await ruleManager.executeBatch(operationsWithDelete, 'test-operator');

    expect(result.success).toBe(false);
    expect(result.results.length).toBe(2);
    expect(result.results[0].success).toBe(true);
    expect(result.results[1].success).toBe(false);

    expect(ruleManager.getRules().length).toBe(1);
    expect(ruleManager.getRule('rule-a')).not.toBeUndefined();
    expect(ruleManager.getRule('rule-b')).toBeUndefined();
    expect(events.length).toBe(0);
  });

  it('should handle enable and disable operations in batch', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const ruleA = createSimpleRule('rule-a', { enabled: true });
    const ruleB = createSimpleRule('rule-b', { enabled: true });
    engine.addRule(ruleA);
    engine.addRule(ruleB);
    (ruleManager as any).rules = [ruleA, ruleB];

    const operations: BatchOperation[] = [
      { action: 'disable', ruleId: 'rule-a' },
      { action: 'enable', ruleId: 'rule-b' },
      { action: 'disable', ruleId: 'rule-b' }
    ];

    const result = await ruleManager.executeBatch(operations, 'admin');

    expect(result.success).toBe(true);
    expect(ruleManager.getRule('rule-a')!.enabled).toBe(false);
    expect(ruleManager.getRule('rule-b')!.enabled).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].changeType).toBe('batch');
  });

  it('should handle delete operations in batch', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const ruleA = createSimpleRule('rule-a');
    const ruleB = createSimpleRule('rule-b');
    engine.addRule(ruleA);
    engine.addRule(ruleB);
    (ruleManager as any).rules = [ruleA, ruleB];

    const operations: BatchOperation[] = [
      { action: 'delete', ruleId: 'rule-a' },
      { action: 'delete', ruleId: 'rule-b' }
    ];

    const result = await ruleManager.executeBatch(operations, 'admin');

    expect(result.success).toBe(true);
    expect(ruleManager.getRules().length).toBe(0);
    expect(events.length).toBe(1);
    expect(events[0].changeType).toBe('batch');
    expect(events[0].changedRuleIds.sort()).toEqual(['rule-a', 'rule-b']);
  });
});

describe('Full integration - batch, patch, and tags with AppRuntime', () => {
  let runtime: AppRuntime;

  beforeEach(() => {
    const config: AppConfig = {
      inputSources: [],
      ruleFiles: [],
      globalOutputs: [{ type: 'console' }],
      dryRun: true,
      timezone: 'UTC'
    };
    runtime = createAppRuntime(config);
  });

  it('should create version snapshot with batch changeType', async () => {
    const vm = runtime.versionManager;

    const rules = [createSimpleRule('r1'), createSimpleRule('r2')];
    const ruleFile = createTempRuleFile(rules);
    await runtime.ruleManager.loadRuleFiles([ruleFile]);
    await new Promise(resolve => setTimeout(resolve, 50));

    const initialVersionCount = vm.getVersionCount();

    const operations: BatchOperation[] = [
      { action: 'create', rule: createSimpleRule('r3') },
      { action: 'update', ruleId: 'r1', changes: { name: 'Updated R1' } }
    ];

    await runtime.ruleManager.executeBatch(operations, 'batch-operator');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(vm.getVersionCount()).toBe(initialVersionCount + 1);
    const latest = vm.getLatestVersion()!;
    expect(latest.changeType).toBe('batch');
    expect(latest.operator).toBe('batch-operator');
    expect(latest.changedRuleIds.sort()).toEqual(['r1', 'r3']);
  });

  it('patch round-trip: generate patch from diff and apply should produce same result', async () => {
    const vm = runtime.versionManager;

    const v1Rules = [createSimpleRule('r1'), createSimpleRule('r2')];
    const v1File = createTempRuleFile(v1Rules);
    await runtime.ruleManager.loadRuleFiles([v1File]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const v1Version = vm.getLatestVersion()!.version;

    const v2Rules = [
      createSimpleRule('r1', { name: 'Updated R1', priority: 20 }),
      createSimpleRule('r3')
    ];
    runtime.ruleEngine.resetAllState();
    const v2File = createTempRuleFile(v2Rules);
    (runtime.ruleManager as any).isReloading = false;
    await runtime.ruleManager.loadRuleFiles([v2File]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const v2Version = vm.getLatestVersion()!.version;

    const diffResult = vm.diffVersionsFormatted(v1Version, v2Version, 'patch');
    expect(diffResult).not.toBeNull();
    const patch = diffResult.patch;

    runtime.ruleEngine.resetAllState();
    const v1Snapshot = vm.getVersion(v1Version)!;
    const currentRules = deepClone(v1Snapshot.rulesAfter);

    const applied = applyJsonPatch(currentRules, patch);
    const v2Snapshot = vm.getVersion(v2Version)!;

    const appliedMap = new Map(applied.map(r => [r.id, r]));
    const v2Map = new Map(v2Snapshot.rulesAfter.map(r => [r.id, r]));

    expect(appliedMap.size).toBe(v2Map.size);
    for (const [id, v2Rule] of v2Map) {
      expect(appliedMap.has(id)).toBe(true);
      const appliedRule = appliedMap.get(id)!;
      expect(appliedRule.name).toBe(v2Rule.name);
      expect(appliedRule.priority).toBe(v2Rule.priority);
    }
  });

  it('applyPatch should create a new version with patch changeType', async () => {
    const vm = runtime.versionManager;

    const rules = [createSimpleRule('r1')];
    const ruleFile = createTempRuleFile(rules);
    await runtime.ruleManager.loadRuleFiles([ruleFile]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const initialVersionCount = vm.getVersionCount();

    const patch = [
      { op: 'add', path: '/rules/1', value: createSimpleRule('r2') },
      { op: 'replace', path: '/rules/0/name', value: 'Patched Rule' }
    ];

    const result = await applyPatch(runtime, patch as any, 'patch-operator');

    expect(result.success).toBe(true);
    expect(vm.getVersionCount()).toBe(initialVersionCount + 1);

    const latest = vm.getLatestVersion()!;
    expect(latest.changeType).toBe('patch');
    expect(latest.operator).toBe('patch-operator');
    expect(latest.changedRuleIds.sort()).toEqual(['r1', 'r2']);

    const r1 = runtime.ruleManager.getRule('r1');
    const r2 = runtime.ruleManager.getRule('r2');
    expect(r1).not.toBeUndefined();
    expect(r1!.name).toBe('Patched Rule');
    expect(r2).not.toBeUndefined();
  });

  it('should create tags and query versions by tag', async () => {
    const vm = runtime.versionManager;

    const rules = [createSimpleRule('r1')];
    const ruleFile = createTempRuleFile(rules);
    await runtime.ruleManager.loadRuleFiles([ruleFile]);
    await new Promise(resolve => setTimeout(resolve, 50));

    const v1 = vm.getLatestVersion()!.version;

    const tag = vm.createTag(v1, 'production-v1', 'Production release v1.0', 'admin');
    expect(tag).not.toBeNull();
    expect(tag!.name).toBe('production-v1');

    const tags = vm.listTags();
    expect(tags.length).toBe(1);
    expect(tags[0].name).toBe('production-v1');

    const snapshotByTag = vm.getVersionByTag('production-v1');
    expect(snapshotByTag).not.toBeUndefined();
    expect(snapshotByTag!.version).toBe(v1);
  });

  it('should return 409-like conflict for duplicate tag names', async () => {
    const vm = runtime.versionManager;

    const rules = [createSimpleRule('r1')];
    const ruleFile = createTempRuleFile(rules);
    await runtime.ruleManager.loadRuleFiles([ruleFile]);
    await new Promise(resolve => setTimeout(resolve, 50));

    const v1 = vm.getLatestVersion()!.version;

    const tag1 = vm.createTag(v1, 'same-name', 'First', 'admin');
    expect(tag1).not.toBeNull();

    const tag2 = vm.createTag(v1, 'same-name', 'Second', 'admin');
    expect(tag2).toBeNull();
  });

  it('should rollback by tag name', async () => {
    const vm = runtime.versionManager;

    const v1Rules = [createSimpleRule('r1'), createSimpleRule('r2')];
    const v1File = createTempRuleFile(v1Rules);
    await runtime.ruleManager.loadRuleFiles([v1File]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const v1Version = vm.getLatestVersion()!.version;

    vm.createTag(v1Version, 'stable', 'Stable version', 'admin');

    const v2Rules = [createSimpleRule('r1', { name: 'Modified R1' })];
    runtime.ruleEngine.resetAllState();
    const v2File = createTempRuleFile(v2Rules);
    (runtime.ruleManager as any).isReloading = false;
    await runtime.ruleManager.loadRuleFiles([v2File]);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(runtime.ruleManager.getRules().map(r => r.id).sort()).toEqual(['r1']);
    expect(runtime.ruleManager.getRule('r1')!.name).toBe('Modified R1');

    const result = await rollbackByTag(runtime, 'stable', 'rollback-op');

    expect(result.success).toBe(true);
    expect(runtime.ruleManager.getRules().map(r => r.id).sort()).toEqual(['r1', 'r2']);
    expect(runtime.ruleManager.getRule('r1')!.name).toBe('Rule r1');

    const latest = vm.getLatestVersion()!;
    expect(latest.changeType).toBe('rollback');
    expect(latest.rollbackFromVersion).toBe(v1Version);
    expect(latest.operator).toBe('rollback-op');
  });

  it('should fail rollback by tag for non-existent tag', async () => {
    const result = await rollbackByTag(runtime, 'nonexistent-tag', 'admin');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('text format diff should be human-readable', async () => {
    const vm = runtime.versionManager;

    const v1Rules = [createSimpleRule('r1'), createSimpleRule('r2')];
    const v1File = createTempRuleFile(v1Rules);
    await runtime.ruleManager.loadRuleFiles([v1File]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const v1Version = vm.getLatestVersion()!.version;

    const v2Rules = [
      createSimpleRule('r1', { name: 'Updated R1' }),
      createSimpleRule('r3')
    ];
    runtime.ruleEngine.resetAllState();
    const v2File = createTempRuleFile(v2Rules);
    (runtime.ruleManager as any).isReloading = false;
    await runtime.ruleManager.loadRuleFiles([v2File]);
    await new Promise(resolve => setTimeout(resolve, 50));
    const v2Version = vm.getLatestVersion()!.version;

    const textDiff = vm.diffVersionsFormatted(v1Version, v2Version, 'text');
    expect(typeof textDiff).toBe('string');
    expect(textDiff.length).toBeGreaterThan(0);
    expect(textDiff).toContain('r1');
    expect(textDiff).toContain('r2');
    expect(textDiff).toContain('r3');
  });
});
