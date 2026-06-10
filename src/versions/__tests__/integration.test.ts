import { AlertRuleEngine } from '../../engine';
import { AlertRule, SimpleCondition, AggregateCondition, StructuredLog } from '../../types';
import { RuleManager } from '../../rules';
import { OutputDispatcher } from '../../outputs';
import { TemplateEngine } from '../../templates';
import { createAppRuntime, AppRuntime, rollbackToVersion } from '../../app/runtime';
import { AppConfig } from '../../types';
import { VersionManager, deepClone, RulesChangedEvent } from '..';
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

describe('AlertRuleEngine - resetAllState', () => {
  it('should reset all rule states including aggregate and sequence engines', () => {
    const engine = new AlertRuleEngine();
    const alerts: any[] = [];
    engine.onAlert(a => alerts.push(a));

    const aggRule: AlertRule = {
      id: 'agg1',
      name: 'Aggregate Rule',
      severity: 'critical',
      priority: 5,
      enabled: true,
      condition: {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 2,
        aggregation: 'count',
        baseCondition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' }
      } as AggregateCondition,
      actions: []
    };
    engine.addRule(aggRule);
    engine.addRule(createSimpleRule('simple1'));

    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      engine.processLog(createLog({ timestamp: now - 30000 + i * 1000 }), now);
    }
    engine.processLog(createLog({ level: 'ERROR', timestamp: now }), now);

    const statsBefore = engine.getRuleStats('simple1')!;
    expect(statsBefore.triggerCount).toBeGreaterThan(0);
    const activeBefore = engine.getActiveAlerts();
    expect(activeBefore.length).toBeGreaterThan(0);

    engine.resetAllState();

    const statsAfter = engine.getRuleStats('simple1')!;
    expect(statsAfter.triggerCount).toBe(0);
    expect(engine.getActiveAlerts().length).toBe(0);
    expect(engine.getAllAlerts().length).toBe(0);

    const triggeredAfterReset = engine.processLog(createLog({ level: 'ERROR' }), Date.now());
    expect(triggeredAfterReset.length).toBe(1);
  });
});

describe('RuleManager - integration with version events', () => {
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

  it('should emit events when enabling/disabling rules with correct operator', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const rule = createSimpleRule('test-rule');
    engine.addRule(rule);
    (ruleManager as any).rules = [rule];

    ruleManager.setRuleEnabled('test-rule', false, 'admin-user');

    expect(events.length).toBe(1);
    expect(events[0].changeType).toBe('disable');
    expect(events[0].changedRuleIds).toEqual(['test-rule']);
    expect(events[0].operator).toBe('admin-user');
    expect(events[0].rulesBefore[0].enabled).toBe(true);
    expect(events[0].rulesAfter[0].enabled).toBe(false);

    ruleManager.setRuleEnabled('test-rule', true, 'another-op');
    expect(events[1].changeType).toBe('enable');
    expect(events[1].operator).toBe('another-op');
  });

  it('should default operator to "system" when not provided', async () => {
    await ruleManager.loadRuleFiles([]);
    events = [];

    const rule = createSimpleRule('x');
    engine.addRule(rule);
    (ruleManager as any).rules = [rule];

    ruleManager.resetRuleState('x');
    expect(events[0].operator).toBe('system');
  });
});

describe('Full integration - VersionManager with AppRuntime and rollback', () => {
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

  it('should create version snapshots when rules are loaded via loadRuleFiles', async () => {
    const vm = runtime.versionManager;
    expect(vm.getVersionCount()).toBe(0);

    const rules = [createSimpleRule('r1'), createSimpleRule('r2')];
    const ruleFile = createTempRuleFile(rules);

    await runtime.ruleManager.loadRuleFiles([ruleFile]);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(vm.getVersionCount()).toBe(1);
    const v1 = vm.getLatestVersion()!;
    expect(v1.changeType).toBe('reload');
    expect(v1.operator).toBe('system');
    expect(v1.changedRuleIds.sort()).toEqual(['r1', 'r2']);
    expect(v1.rulesAfter.length).toBe(2);
  });

  it('should rollback rules to a previous version and create a new rollback snapshot', async () => {
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

    expect(vm.getVersionCount()).toBe(2);
    expect(runtime.ruleManager.getRules().map(r => r.id).sort()).toEqual(['r1', 'r3']);

    const currentRulesBeforeRollback = deepClone(runtime.ruleManager.getRules());
    const r1Before = currentRulesBeforeRollback.find(r => r.id === 'r1')!;
    expect(r1Before.name).toBe('Updated R1');

    const result = await rollbackToVersion(runtime, v1Version, 'rollback-operator');

    expect(result.success).toBe(true);
    expect(result.restoredRuleCount).toBe(2);
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);
    expect(result.newVersion).toBe(3);

    const currentRules = runtime.ruleManager.getRules();
    expect(currentRules.map(r => r.id).sort()).toEqual(['r1', 'r2']);
    expect(currentRules.find(r => r.id === 'r1')!.name).toBe('Rule r1');

    await new Promise(resolve => setTimeout(resolve, 50));
    const rollbackSnapshot = vm.getLatestVersion()!;
    expect(rollbackSnapshot.changeType).toBe('rollback');
    expect(rollbackSnapshot.operator).toBe('rollback-operator');
    expect(rollbackSnapshot.rollbackFromVersion).toBe(v1Version);
    expect(rollbackSnapshot.changedRuleIds.sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('should return 404-like result when rolling back to non-existent version', async () => {
    const result = await rollbackToVersion(runtime, 9999, 'admin');
    expect(result.success).toBe(false);
    expect(result.restoredRuleCount).toBe(0);
    expect(result.newVersion).toBe(0);
  });

  it('should preserve engine state reset during rollback', async () => {
    const vm = runtime.versionManager;

    const v1Rules = [createSimpleRule('trigger-rule')];
    const v1File = createTempRuleFile(v1Rules);
    await runtime.ruleManager.loadRuleFiles([v1File]);
    await new Promise(resolve => setTimeout(resolve, 50));

    const v1Version = vm.getLatestVersion()!.version;

    const v2Rules = [createSimpleRule('trigger-rule', { enabled: true, name: 'Different' })];
    runtime.ruleEngine.resetAllState();
    const v2File = createTempRuleFile(v2Rules);
    (runtime.ruleManager as any).isReloading = false;
    await runtime.ruleManager.loadRuleFiles([v2File]);
    await new Promise(resolve => setTimeout(resolve, 50));

    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      runtime.ruleEngine.processLog(createLog({ timestamp: now - i * 1000 }), now);
    }
    const statsBefore = runtime.ruleEngine.getRuleStats('trigger-rule')!;
    expect(statsBefore.triggerCount).toBeGreaterThan(0);

    await rollbackToVersion(runtime, v1Version, 'admin');

    const statsAfter = runtime.ruleEngine.getRuleStats('trigger-rule')!;
    expect(statsAfter.triggerCount).toBe(0);
  });
});
