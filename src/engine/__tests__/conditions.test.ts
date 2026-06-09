import { evaluateCondition } from '../conditions';
import { SimpleCondition, CompositeCondition, StructuredLog } from '../../types';

function createLog(overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp: Date.now(),
    level: 'INFO',
    source: 'test',
    message: 'test message',
    fields: {},
    raw: '',
    ...overrides
  };
}

describe('Condition Evaluator', () => {
  describe('Simple conditions - equality', () => {
    it('should evaluate field == value', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'level', operator: '==', value: 'ERROR' };
      const log = createLog({ level: 'ERROR' });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });

    it('should evaluate field != value', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'level', operator: '!=', value: 'ERROR' };
      const log = createLog({ level: 'INFO' });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });

    it('should handle numeric equality loose', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'fields.status', operator: '==', value: '200' };
      const log = createLog({ fields: { status: 200 } });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });
  });

  describe('Simple conditions - comparison', () => {
    it('should evaluate numeric > comparison', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'fields.response_time', operator: '>', value: 5.0 };
      const log = createLog({ fields: { response_time: 6.5 } });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });

    it('should evaluate >= comparison', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'fields.status', operator: '>=', value: 500 };
      expect(evaluateCondition(cond, createLog({ fields: { status: 500 } })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ fields: { status: 499 } })).matched).toBe(false);
    });

    it('should evaluate string comparison', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'source', operator: '<', value: 'zzz' };
      expect(evaluateCondition(cond, createLog({ source: 'aaa' })).matched).toBe(true);
    });
  });

  describe('Simple conditions - string operations', () => {
    it('should evaluate contains', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'message', operator: 'contains', value: 'OutOfMemory' };
      const log = createLog({ message: 'Java heap OutOfMemory error occurred' });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });

    it('should evaluate not_contains', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'message', operator: 'not_contains', value: 'error' };
      const log = createLog({ message: 'all good here' });
      expect(evaluateCondition(cond, log).matched).toBe(true);
    });

    it('should evaluate regex matches', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'fields.path', operator: 'matches', value: '/api/v[0-9]+/users' };
      const log1 = createLog({ fields: { path: '/api/v1/users' } });
      const log2 = createLog({ fields: { path: '/api/v2/users' } });
      const log3 = createLog({ fields: { path: '/other/path' } });
      expect(evaluateCondition(cond, log1).matched).toBe(true);
      expect(evaluateCondition(cond, log2).matched).toBe(true);
      expect(evaluateCondition(cond, log3).matched).toBe(false);
    });

    it('should handle invalid regex gracefully', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'message', operator: 'matches', value: '[invalid' };
      const log = createLog();
      expect(evaluateCondition(cond, log).matched).toBe(false);
    });
  });

  describe('Simple conditions - in operator', () => {
    it('should evaluate in array', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'level', operator: 'in', value: ['ERROR', 'FATAL'] };
      expect(evaluateCondition(cond, createLog({ level: 'ERROR' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'FATAL' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'WARN' })).matched).toBe(false);
    });

    it('should evaluate not_in', () => {
      const cond: SimpleCondition = { type: 'simple', field: 'level', operator: 'not_in', value: ['DEBUG', 'INFO'] };
      expect(evaluateCondition(cond, createLog({ level: 'ERROR' })).matched).toBe(true);
    });
  });

  describe('Composite conditions', () => {
    it('should evaluate AND condition', () => {
      const cond: CompositeCondition = {
        type: 'composite',
        operator: 'AND',
        conditions: [
          { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
          { type: 'simple', field: 'message', operator: 'contains', value: 'database' }
        ]
      };
      const log1 = createLog({ level: 'ERROR', message: 'database connection failed' });
      const log2 = createLog({ level: 'ERROR', message: 'other error' });
      expect(evaluateCondition(cond, log1).matched).toBe(true);
      expect(evaluateCondition(cond, log2).matched).toBe(false);
    });

    it('should evaluate OR condition', () => {
      const cond: CompositeCondition = {
        type: 'composite',
        operator: 'OR',
        conditions: [
          { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
          { type: 'simple', field: 'level', operator: '==', value: 'FATAL' }
        ]
      };
      expect(evaluateCondition(cond, createLog({ level: 'ERROR' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'FATAL' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'INFO' })).matched).toBe(false);
    });

    it('should evaluate NOT condition', () => {
      const cond: CompositeCondition = {
        type: 'composite',
        operator: 'NOT',
        conditions: [
          { type: 'simple', field: 'level', operator: '==', value: 'DEBUG' }
        ]
      };
      expect(evaluateCondition(cond, createLog({ level: 'INFO' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'DEBUG' })).matched).toBe(false);
    });

    it('should evaluate nested composite conditions', () => {
      const cond: CompositeCondition = {
        type: 'composite',
        operator: 'OR',
        conditions: [
          {
            type: 'composite',
            operator: 'AND',
            conditions: [
              { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
              { type: 'simple', field: 'message', operator: 'contains', value: 'payment' }
            ]
          },
          {
            type: 'composite',
            operator: 'AND',
            conditions: [
              { type: 'simple', field: 'level', operator: '==', value: 'FATAL' },
              { type: 'composite', operator: 'NOT', conditions: [
                { type: 'simple', field: 'message', operator: 'contains', value: 'ignored' }
              ]}
            ]
          }
        ]
      };
      expect(evaluateCondition(cond, createLog({ level: 'ERROR', message: 'payment failed' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'FATAL', message: 'crash' })).matched).toBe(true);
      expect(evaluateCondition(cond, createLog({ level: 'FATAL', message: 'ignored crash' })).matched).toBe(false);
    });
  });
});
