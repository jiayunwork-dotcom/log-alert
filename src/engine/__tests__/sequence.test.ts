import { SequenceRuleEngine } from '../sequence';
import { SequenceCondition, StructuredLog, SimpleCondition } from '../../types';

function createLog(timestamp: number, overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp,
    level: 'INFO',
    source: 'test',
    message: '',
    fields: {},
    raw: '',
    ...overrides
  };
}

describe('SequenceRuleEngine', () => {
  it('should detect two-step sequence', () => {
    const cond: SequenceCondition = {
      type: 'sequence',
      keyField: 'fields.user_id',
      maxTotalSeconds: 60,
      events: [
        {
          eventId: 'login_failed',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: 'contains', value: 'login fail' } as SimpleCondition
        },
        {
          eventId: 'login_success',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: 'contains', value: 'login success' } as SimpleCondition
        }
      ]
    };
    const engine = new SequenceRuleEngine(cond);

    const start = Date.now();
    let results = [];
    results.push(...engine.process(createLog(start, { message: 'login fail', fields: { user_id: 'user1' } }), start));
    results.push(...engine.process(createLog(start + 5000, { message: 'login success', fields: { user_id: 'user1' } }), start + 5000));

    const triggered = results.filter(r => r.triggered);
    expect(triggered.length).toBe(1);
    expect(triggered[0].sequenceKey).toBe('user1');
  });

  it('should not trigger sequence with timeout', () => {
    const cond: SequenceCondition = {
      type: 'sequence',
      keyField: 'fields.user_id',
      maxTotalSeconds: 60,
      events: [
        {
          eventId: 'step1',
          timeoutSeconds: 5,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'step1' } as SimpleCondition
        },
        {
          eventId: 'step2',
          timeoutSeconds: 5,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'step2' } as SimpleCondition
        }
      ]
    };
    const engine = new SequenceRuleEngine(cond);

    const start = Date.now();
    let results = [];
    results.push(...engine.process(createLog(start, { message: 'step1', fields: { user_id: 'u1' } }), start));
    results.push(...engine.process(createLog(start + 20000, { message: 'step2', fields: { user_id: 'u1' } }), start + 20000));

    expect(results.filter(r => r.triggered).length).toBe(0);
  });

  it('should maintain separate state per key', () => {
    const cond: SequenceCondition = {
      type: 'sequence',
      keyField: 'fields.user_id',
      maxTotalSeconds: 60,
      events: [
        {
          eventId: 'step1',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'A' } as SimpleCondition
        },
        {
          eventId: 'step2',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'B' } as SimpleCondition
        }
      ]
    };
    const engine = new SequenceRuleEngine(cond);

    const start = Date.now();
    let results = [];
    results.push(...engine.process(createLog(start, { message: 'A', fields: { user_id: 'u1' } }), start));
    results.push(...engine.process(createLog(start + 1000, { message: 'A', fields: { user_id: 'u2' } }), start + 1000));
    results.push(...engine.process(createLog(start + 2000, { message: 'B', fields: { user_id: 'u1' } }), start + 2000));
    results.push(...engine.process(createLog(start + 3000, { message: 'B', fields: { user_id: 'u2' } }), start + 3000));

    const triggered = results.filter(r => r.triggered);
    expect(triggered.length).toBe(2);
    expect(new Set(triggered.map(t => t.sequenceKey)).size).toBe(2);
  });

  it('should not trigger for missing key field', () => {
    const cond: SequenceCondition = {
      type: 'sequence',
      keyField: 'fields.user_id',
      maxTotalSeconds: 60,
      events: [
        {
          eventId: 'step1',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'A' } as SimpleCondition
        },
        {
          eventId: 'step2',
          timeoutSeconds: 30,
          condition: { type: 'simple', field: 'message', operator: '==', value: 'B' } as SimpleCondition
        }
      ]
    };
    const engine = new SequenceRuleEngine(cond);

    const start = Date.now();
    const results = engine.process(createLog(start, { message: 'A' }), start);
    expect(results.filter(r => r.triggered).length).toBe(0);
  });
});
