import { AlertRuleEngine } from '../../engine';
import { AlertRule, SimpleCondition } from '../../types';
import { RuleManager } from '../../rules';
import { OutputDispatcher } from '../../outputs';
import { TemplateEngine } from '../../templates';
import { createAppRuntime, AppRuntime, applyPatch, extractAffectedRuleIdsFromPatch } from '../../app/runtime';
import { AppConfig } from '../../types';
import { VersionManager, deepClone, BatchOperation, diffRules, applyJsonPatch, diffToJsonPatch } from '..';
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

function createTempRuleFile(rules: AlertRule[]): string {
  const rawRules = rules.map(r => {
    const cond = r.condition as SimpleCondition;
    return {
      id: r.id,
      name: r.name,
      severity: r.severity,
      condition: { type: 'simple', field: cond.field, operator: cond.operator, value: cond.value }
    };
  });
  const content = yaml.dump(rawRules);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-alert-bug-test-'));
  const filePath = path.join(tmpDir, 'rules.yaml');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('Bug Fixes', () => {
  describe('Bug 1: batch API returns version 0 instead of 1', () => {
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

    it('should return correct version number after batch operation', async () => {
      const vm = runtime.versionManager;
      expect(vm.getVersionCount()).toBe(0);

      const operations: BatchOperation[] = [
        { action: 'create', rule: createSimpleRule('rule-b') },
        { action: 'create', rule: createSimpleRule('rule-a') }
      ];

      const result = await runtime.ruleManager.executeBatch(operations, 'test-operator');
      expect(result.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));

      const latestVersion = vm.getLatestVersion();
      expect(latestVersion).not.toBeUndefined();
      expect(latestVersion!.version).toBe(1);

      const operations2: BatchOperation[] = [
        { action: 'update', ruleId: 'rule-b', changes: { name: 'Updated Rule B' } }
      ];

      const result2 = await runtime.ruleManager.executeBatch(operations2, 'test-operator');
      expect(result2.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));

      const latestVersion2 = vm.getLatestVersion();
      expect(latestVersion2).not.toBeUndefined();
      expect(latestVersion2!.version).toBe(2);
    });
  });

  describe('Bug 2: rulesAfter order does not match batch operation order', () => {
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

    it('should preserve batch create order in rulesAfter', async () => {
      const vm = runtime.versionManager;

      const operations: BatchOperation[] = [
        { action: 'create', rule: createSimpleRule('rule-b') },
        { action: 'create', rule: createSimpleRule('rule-a') },
        { action: 'create', rule: createSimpleRule('rule-c') }
      ];

      const result = await runtime.ruleManager.executeBatch(operations, 'test-operator');
      expect(result.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));

      const latestVersion = vm.getLatestVersion();
      expect(latestVersion).not.toBeUndefined();
      expect(latestVersion!.version).toBe(1);

      const ruleIdsInOrder = latestVersion!.rulesAfter.map(r => r.id);
      expect(ruleIdsInOrder).toEqual(['rule-b', 'rule-a', 'rule-c']);

      vm.createTag(1, 'test-tag', 'Test tag', 'admin');

      const snapshotByTag = vm.getVersionByTag('test-tag');
      expect(snapshotByTag).not.toBeUndefined();

      const ruleIdsByTag = snapshotByTag!.rulesAfter.map(r => r.id);
      expect(ruleIdsByTag).toEqual(['rule-b', 'rule-a', 'rule-c']);
    });

    it('should preserve order with mixed create and update operations', async () => {
      const vm = runtime.versionManager;

      const initialRules = [createSimpleRule('rule-x')];
      const ruleFile = createTempRuleFile(initialRules);
      await runtime.ruleManager.loadRuleFiles([ruleFile]);
      await new Promise(resolve => setTimeout(resolve, 50));

      const operations: BatchOperation[] = [
        { action: 'create', rule: createSimpleRule('rule-b') },
        { action: 'create', rule: createSimpleRule('rule-a') },
        { action: 'update', ruleId: 'rule-x', changes: { name: 'Updated X' } }
      ];

      const result = await runtime.ruleManager.executeBatch(operations, 'test-operator');
      expect(result.success).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));

      const latestVersion = vm.getLatestVersion();
      expect(latestVersion).not.toBeUndefined();

      const ruleIdsInOrder = latestVersion!.rulesAfter.map(r => r.id);
      expect(ruleIdsInOrder).toEqual(['rule-x', 'rule-b', 'rule-a']);
    });
  });

  describe('Bug 3: apply-patch returns empty changed_rule_ids for remove operation', () => {
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

    it('should include removed rule id in changedRuleIds', async () => {
      const rules = [
        createSimpleRule('rule-0'),
        createSimpleRule('rule-1'),
        createSimpleRule('rule-2')
      ];
      const ruleFile = createTempRuleFile(rules);
      await runtime.ruleManager.loadRuleFiles([ruleFile]);
      await new Promise(resolve => setTimeout(resolve, 50));

      const currentRules = runtime.ruleManager.getRules();
      expect(currentRules.length).toBe(3);

      const patch = [
        { op: 'remove', path: '/rules/1' }
      ];

      const result = await applyPatch(runtime, patch as any, 'patch-operator');

      expect(result.success).toBe(true);
      expect(result.changedRuleIds).toContain('rule-1');
      expect(result.changedRuleIds.length).toBe(1);

      const remainingRules = runtime.ruleManager.getRules();
      expect(remainingRules.length).toBe(2);
      expect(remainingRules.map(r => r.id)).toEqual(['rule-0', 'rule-2']);
    });

    it('should include all changed rule ids for mixed operations', async () => {
      const rules = [
        createSimpleRule('rule-0'),
        createSimpleRule('rule-1')
      ];
      const ruleFile = createTempRuleFile(rules);
      await runtime.ruleManager.loadRuleFiles([ruleFile]);
      await new Promise(resolve => setTimeout(resolve, 50));

      const patch = [
        { op: 'remove', path: '/rules/0' },
        { op: 'replace', path: '/rules/0/name', value: 'Updated Rule 1' },
        { op: 'add', path: '/rules/1', value: createSimpleRule('rule-2') }
      ];

      const result = await applyPatch(runtime, patch as any, 'patch-operator');

      expect(result.success).toBe(true);
      expect(result.changedRuleIds.sort()).toEqual(['rule-0', 'rule-1', 'rule-2']);

      const finalRules = runtime.ruleManager.getRules();
      expect(finalRules.length).toBe(2);
      expect(finalRules.map(r => r.id)).toEqual(['rule-1', 'rule-2']);
      expect(finalRules[0].name).toBe('Updated Rule 1');
    });

    it('diffRules should correctly detect removed rules', () => {
      const rulesV1 = [
        createSimpleRule('rule-a'),
        createSimpleRule('rule-b'),
        createSimpleRule('rule-c')
      ];
      const rulesV2 = [
        createSimpleRule('rule-a'),
        createSimpleRule('rule-c')
      ];

      const diff = diffRules(rulesV1, rulesV2);
      expect(diff.removed.length).toBe(1);
      expect(diff.removed[0].id).toBe('rule-b');
    });

    it('applyJsonPatch should correctly remove rule at index', () => {
      const rules = [
        createSimpleRule('rule-0'),
        createSimpleRule('rule-1'),
        createSimpleRule('rule-2')
      ];

      const patch = [{ op: 'remove', path: '/rules/1' }];
      const result = applyJsonPatch(rules, patch as any);

      expect(result.length).toBe(2);
      expect(result.map(r => r.id)).toEqual(['rule-0', 'rule-2']);
    });

    it('diffToJsonPatch should generate correct indices for multiple add operations', () => {
      const v1 = [
        createSimpleRule('rule-c')
      ];
      const v2 = [
        createSimpleRule('rule-a'),
        createSimpleRule('rule-b'),
        createSimpleRule('rule-c')
      ];

      const patch = diffToJsonPatch(v1, v2);
      const addOps = patch.filter(op => op.op === 'add');
      expect(addOps.length).toBe(2);
      expect(addOps[0].path).toBe('/rules/0');
      expect(addOps[1].path).toBe('/rules/1');

      const result = applyJsonPatch(v1, patch);
      expect(result.map(r => r.id)).toEqual(['rule-a', 'rule-b', 'rule-c']);
    });

    it('diffToJsonPatch should handle mixed add and remove operations', () => {
      const v1 = [
        createSimpleRule('rule-b'),
        createSimpleRule('rule-c'),
        createSimpleRule('rule-d')
      ];
      const v2 = [
        createSimpleRule('rule-a'),
        createSimpleRule('rule-b'),
        createSimpleRule('rule-e')
      ];

      const patch = diffToJsonPatch(v1, v2);
      const result = applyJsonPatch(v1, patch);

      expect(result.map(r => r.id)).toEqual(['rule-a', 'rule-b', 'rule-e']);
    });

    it('diffToJsonPatch round-trip should preserve order', () => {
      const v1 = [
        createSimpleRule('rule-c'),
        createSimpleRule('rule-d')
      ];
      const v2 = [
        createSimpleRule('rule-a'),
        createSimpleRule('rule-b'),
        createSimpleRule('rule-c'),
        createSimpleRule('rule-e')
      ];

      const patch = diffToJsonPatch(v1, v2);
      const result = applyJsonPatch(v1, patch);

      expect(result.map(r => r.id)).toEqual(v2.map(r => r.id));
    });

    it('extractAffectedRuleIdsFromPatch should include removed rule IDs', () => {
      const rules = [
        createSimpleRule('rule-0'),
        createSimpleRule('rule-1'),
        createSimpleRule('rule-2')
      ];

      const patch = [
        { op: 'remove', path: '/rules/1' }
      ] as const;

      const affected = extractAffectedRuleIdsFromPatch(rules, patch as any);
      expect(affected).toContain('rule-1');
      expect(affected.length).toBe(1);
    });

    it('extractAffectedRuleIdsFromPatch should handle mixed operations', () => {
      const rules = [
        createSimpleRule('rule-0'),
        createSimpleRule('rule-1')
      ];

      const patch = [
        { op: 'remove', path: '/rules/0' },
        { op: 'replace', path: '/rules/0/name', value: 'Updated Rule 1' },
        { op: 'add', path: '/rules/1', value: createSimpleRule('rule-2') }
      ] as const;

      const affected = extractAffectedRuleIdsFromPatch(rules, patch as any);
      expect(affected.sort()).toEqual(['rule-0', 'rule-1', 'rule-2']);
    });
  });
});
