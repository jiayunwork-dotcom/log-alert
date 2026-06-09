import { AlertRuleEngine } from '../index';
import { AlertRule, StructuredLog, SimpleCondition, AggregateCondition } from '../../types';

function createLog(timestamp: number, overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp,
    level: 'INFO',
    source: 'test',
    message: 'test',
    fields: {},
    raw: '',
    ...overrides
  };
}

describe('AlertRuleEngine', () => {
  describe('Simple rule processing', () => {
    it('should trigger alert when condition matches', () => {
      const engine = new AlertRuleEngine();
      const alerts: any[] = [];
      engine.onAlert(a => alerts.push(a));

      const rule: AlertRule = {
        id: 'rule1',
        name: 'Error Detection',
        severity: 'warning',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      const now = Date.now();
      const log = createLog(now, { level: 'ERROR' });
      const triggered = engine.processLog(log, now);

      expect(triggered.length).toBe(1);
      expect(triggered[0].ruleId).toBe('rule1');
      expect(alerts.length).toBe(1);
    });

    it('should respect cooldown period', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'rule1',
        name: 'Error Detection',
        severity: 'warning',
        priority: 10,
        enabled: true,
        cooldownSeconds: 10,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      const t1 = Date.now();
      engine.processLog(createLog(t1, { level: 'ERROR' }), t1);
      const t2 = t1 + 5000;
      const result2 = engine.processLog(createLog(t2, { level: 'ERROR' }), t2);
      const t3 = t1 + 15000;
      const result3 = engine.processLog(createLog(t3, { level: 'ERROR' }), t3);

      expect(result2.length).toBe(0);
      expect(result3.length).toBe(1);
    });

    it('should respect enabled flag', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'rule1',
        name: 'Disabled Rule',
        severity: 'warning',
        priority: 10,
        enabled: false,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      const now = Date.now();
      const result = engine.processLog(createLog(now, { level: 'ERROR' }), now);
      expect(result.length).toBe(0);
    });
  });

  describe('Deduplication', () => {
    it('should deduplicate same messages within window', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'rule1',
        name: 'Dedup Rule',
        severity: 'warning',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: [],
        dedup: { windowSeconds: 60, hashPrefixLength: 64 }
      };
      engine.addRule(rule);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(...engine.processLog(createLog(now + i * 1000, { level: 'ERROR', message: 'Same error message' }), now + i * 1000));
      }

      expect(results.length).toBe(1);
    });
  });

  describe('Priority ordering', () => {
    it('should process rules in priority order (lower number first)', () => {
      const engine = new AlertRuleEngine();
      const executionOrder: string[] = [];

      const rules: AlertRule[] = [
        {
          id: 'low',
          name: 'Low Priority',
          severity: 'info',
          priority: 100,
          enabled: true,
          condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
          actions: []
        },
        {
          id: 'high',
          name: 'High Priority',
          severity: 'critical',
          priority: 1,
          enabled: true,
          condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
          actions: []
        }
      ];

      engine.onAlert(a => executionOrder.push(a.ruleId));
      rules.forEach(r => engine.addRule(r));

      const now = Date.now();
      engine.processLog(createLog(now, { level: 'ERROR' }), now);

      expect(executionOrder[0]).toBe('high');
      expect(executionOrder[1]).toBe('low');
    });
  });

  describe('Rule statistics', () => {
    it('should track trigger statistics', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'rule1',
        name: 'Stats Test',
        severity: 'warning',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      const times = [1000, 2000, 3000, 4000, 5000];
      times.forEach(t => engine.processLog(createLog(t, { level: 'ERROR' }), t));

      const stats = engine.getRuleStats('rule1');
      expect(stats?.triggerCount).toBe(5);
      expect(stats?.firstTriggeredAt).toBe(1000);
      expect(stats?.lastTriggeredAt).toBe(5000);
      expect(stats?.averageIntervalMs).toBe(1000);
    });
  });

  describe('Aggregate rule integration', () => {
    it('should trigger aggregate rule through engine', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'agg1',
        name: 'Error Rate',
        severity: 'critical',
        priority: 5,
        enabled: true,
        condition: {
          type: 'aggregate',
          windowSeconds: 60,
          slideSeconds: 10,
          threshold: 3,
          aggregation: 'count',
          baseCondition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' }
        } as AggregateCondition,
        actions: []
      };
      engine.addRule(rule);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(...engine.processLog(createLog(now - 5000 + i * 1000, { level: 'ERROR' }), now));
      }

      expect(results.filter(r => r.ruleId === 'agg1').length).toBeGreaterThan(0);
    });
  });

  describe('Rule management', () => {
    it('should add and remove rules', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'test',
        name: 'Test',
        severity: 'info',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'INFO' } as SimpleCondition,
        actions: []
      };

      engine.addRule(rule);
      expect(engine.getRule('test')).toBeDefined();

      engine.removeRule('test');
      expect(engine.getRule('test')).toBeUndefined();
    });

    it('should set rule enabled state', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'test',
        name: 'Test',
        severity: 'info',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      expect(engine.setRuleEnabled('test', false)).toBe(true);
      const result = engine.processLog(createLog(Date.now(), { level: 'ERROR' }));
      expect(result.length).toBe(0);

      expect(engine.setRuleEnabled('nonexistent', true)).toBe(false);
    });

    it('should suppress rule for duration', () => {
      const engine = new AlertRuleEngine();
      const rule: AlertRule = {
        id: 'test',
        name: 'Test',
        severity: 'info',
        priority: 10,
        enabled: true,
        condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' } as SimpleCondition,
        actions: []
      };
      engine.addRule(rule);

      engine.suppressRule('test', 10);
      const now = Date.now();
      const result = engine.processLog(createLog(now, { level: 'ERROR' }), now);
      expect(result.length).toBe(0);
    });
  });
});
