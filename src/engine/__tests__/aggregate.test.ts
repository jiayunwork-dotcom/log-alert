import { AggregateRuleEngine } from '../aggregate';
import { AggregateCondition, StructuredLog, SimpleCondition } from '../../types';

function createLog(timestamp: number, overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp,
    level: 'ERROR',
    source: 'test',
    message: 'error log',
    fields: {},
    raw: '',
    ...overrides
  };
}

describe('AggregateRuleEngine', () => {
  describe('Count aggregation - global', () => {
    it('should trigger when count exceeds threshold', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'level', operator: '==', value: 'ERROR' };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 3,
        aggregation: 'count',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) {
        const log = createLog(now - 5000 + i * 1000);
        results.push(...engine.process(log, now));
      }

      const triggered = results.filter(r => r.triggered);
      expect(triggered.length).toBeGreaterThan(0);
      expect(triggered[triggered.length - 1].count).toBeGreaterThanOrEqual(3);
    });

    it('should not trigger when below threshold', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'level', operator: '==', value: 'ERROR' };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 10,
        aggregation: 'count',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 3; i++) {
        const log = createLog(now - 1000 + i * 100);
        results.push(...engine.process(log, now));
      }

      expect(results.filter(r => r.triggered).length).toBe(0);
    });
  });

  describe('Count aggregation - grouped', () => {
    it('should trigger per group when exceeding threshold', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'fields.status', operator: '==', value: 404 };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 3,
        groupBy: ['fields.client_ip'],
        aggregation: 'count',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) {
        const log = createLog(now - 5000 + i * 500, { fields: { status: 404, client_ip: '192.168.1.1' } });
        results.push(...engine.process(log, now));
      }
      for (let i = 0; i < 2; i++) {
        const log = createLog(now - 2000 + i * 500, { fields: { status: 404, client_ip: '10.0.0.1' } });
        results.push(...engine.process(log, now));
      }

      const triggered = results.filter(r => r.triggered);
      expect(triggered.length).toBeGreaterThan(0);
      expect(triggered.some(t => t.groupKey === '192.168.1.1')).toBe(true);
    });
  });

  describe('Avg aggregation', () => {
    it('should trigger when average exceeds threshold', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'fields.response_time', operator: '>', value: 0 };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 2.0,
        aggregation: 'avg',
        aggregateField: 'fields.response_time',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      const now = Date.now();
      const results = [];
      const values = [1.5, 2.5, 3.0, 2.0, 2.5];
      for (let i = 0; i < values.length; i++) {
        const log = createLog(now - 5000 + i * 500, { fields: { response_time: values[i] } });
        results.push(...engine.process(log, now));
      }

      const triggered = results.filter(r => r.triggered);
      expect(triggered.length).toBeGreaterThan(0);
    });
  });

  describe('Sum aggregation', () => {
    it('should trigger when sum exceeds threshold', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'fields.bytes', operator: '>', value: 0 };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 60,
        slideSeconds: 10,
        threshold: 1000,
        aggregation: 'sum',
        aggregateField: 'fields.bytes',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      const now = Date.now();
      const results = [];
      for (let i = 0; i < 5; i++) {
        const log = createLog(now - 3000 + i * 500, { fields: { bytes: 300 } });
        results.push(...engine.process(log, now));
      }

      const triggered = results.filter(r => r.triggered);
      expect(triggered.length).toBeGreaterThan(0);
      expect(triggered[triggered.length - 1].value).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('Window eviction', () => {
    it('should evict old data outside window', () => {
      const baseCond: SimpleCondition = { type: 'simple', field: 'level', operator: '==', value: 'ERROR' };
      const aggCond: AggregateCondition = {
        type: 'aggregate',
        windowSeconds: 10,
        slideSeconds: 5,
        threshold: 3,
        aggregation: 'count',
        baseCondition: baseCond
      };
      const engine = new AggregateRuleEngine(aggCond);

      let now = Date.now();
      for (let i = 0; i < 3; i++) {
        engine.process(createLog(now - 60000 + i * 1000), now);
      }

      const stats = engine.getCurrentStats(now);
      expect(stats.count).toBe(0);
    });
  });
});
