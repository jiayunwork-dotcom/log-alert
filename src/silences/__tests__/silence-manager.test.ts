import { SilenceManager } from '../index';
import { Silence, TriggeredAlert, AlertRule, StructuredLog, Severity } from '../../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

function createLog(timestamp: number, fields: Record<string, any> = {}): StructuredLog {
  return {
    timestamp,
    level: 'ERROR',
    source: 'test',
    message: 'test error',
    fields,
    raw: ''
  };
}

function createAlert(overrides: Partial<TriggeredAlert> = {}): TriggeredAlert {
  const now = Date.now();
  return {
    id: 'alert-' + Math.random().toString(36).substr(2, 9),
    ruleId: overrides.ruleId || 'rule-1',
    ruleName: overrides.ruleName || 'Test Rule',
    severity: (overrides.severity as Severity) || 'warning',
    originalSeverity: (overrides.originalSeverity as Severity) || overrides.severity as Severity || 'warning',
    triggeredAt: overrides.triggeredAt || now,
    logs: overrides.logs || [createLog(now)],
    extraFields: overrides.extraFields || {},
    sequenceKey: overrides.sequenceKey,
    groupKey: overrides.groupKey,
    ...overrides
  };
}

describe('SilenceManager', () => {
  let manager: SilenceManager;

  beforeEach(() => {
    manager = new SilenceManager();
  });

  afterEach(() => {
    manager.stop();
  });

  describe('CRUD operations', () => {
    it('should create silence with durationSeconds', () => {
      const now = Date.now();
      const silence = manager.createSilence({
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test-user',
        comment: 'Test silence'
      });

      expect(silence.id).toBeDefined();
      expect(silence.createdBy).toBe('test-user');
      expect(silence.comment).toBe('Test silence');
      expect(silence.matchers.ruleIds).toEqual(['rule-1']);
      expect(silence.endsAt - silence.startsAt).toBe(3600 * 1000);
      expect(manager.getSilence(silence.id)).toBeDefined();
    });

    it('should accept snake_case parameters (rule_ids, created_by, duration_seconds)', () => {
      const now = Date.now();
      const silence = manager.createSilence({
        duration_seconds: 7200,
        matchers: {
          rule_ids: ['error_log_detected']
        } as any,
        created_by: 'ops-team@example.com',
        comment: 'Snake case params'
      } as any);

      expect(silence.createdBy).toBe('ops-team@example.com');
      expect(silence.matchers.ruleIds).toEqual(['error_log_detected']);
      expect(silence.matchers.ruleIds).not.toBeUndefined();
      expect(silence.endsAt - silence.startsAt).toBe(7200 * 1000);
    });

    it('should match only specified rule_ids and not suppress other rules', () => {
      manager.createSilence({
        duration_seconds: 3600,
        matchers: { rule_ids: ['error_log_detected'] } as any
      } as any);

      const matching = manager.getMatchingSilences('error_log_detected', undefined);
      const notMatching = manager.getMatchingSilences('http_5xx_error', undefined);
      const alsoNotMatching = manager.getMatchingSilences('another_rule', undefined);

      expect(matching.length).toBe(1);
      expect(notMatching.length).toBe(0);
      expect(alsoNotMatching.length).toBe(0);
    });

    it('should create silence with explicit start and end times', () => {
      const now = Date.now();
      const startsAt = now;
      const endsAt = now + 7200 * 1000;

      const silence = manager.createSilence({
        startsAt,
        endsAt,
        matchers: { labels: { env: 'production' } }
      });

      expect(silence.startsAt).toBe(startsAt);
      expect(silence.endsAt).toBe(endsAt);
      expect(silence.matchers.labels).toEqual({ env: 'production' });
    });

    it('should delete silence', () => {
      const silence = manager.createSilence({
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-1'] }
      });

      expect(manager.deleteSilence(silence.id)).toBe(true);
      expect(manager.getSilence(silence.id)).toBeUndefined();
      expect(manager.deleteSilence(silence.id)).toBe(false);
    });

    it('should extend silence', () => {
      const now = Date.now();
      const silence = manager.createSilence({
        startsAt: now,
        endsAt: now + 3600 * 1000,
        matchers: { ruleIds: ['rule-1'] }
      });

      const originalEndsAt = silence.endsAt;
      jest.useFakeTimers().setSystemTime(now + 1000);
      const extended = manager.extendSilence(silence.id, 1800);

      expect(extended).not.toBeNull();
      expect(extended!.endsAt).toBeGreaterThan(originalEndsAt);
      expect(extended!.updatedAt).toBeGreaterThan(silence.createdAt);
      jest.useRealTimers();
    });

    it('should return null when extending non-existent silence', () => {
      expect(manager.extendSilence('non-existent', 100)).toBeNull();
    });

    it('should list all silences including expired', () => {
      const now = Date.now();

      manager.createSilence({
        startsAt: now - 10000,
        endsAt: now - 5000,
        matchers: { ruleIds: ['expired-rule'] }
      });

      manager.createSilence({
        startsAt: now,
        endsAt: now + 5000,
        matchers: { ruleIds: ['active-rule'] }
      });

      const all = manager.getAllSilences(true);
      const active = manager.getAllSilences(false);

      expect(all.length).toBe(2);
      expect(active.length).toBe(1);
      expect(active[0].matchers.ruleIds).toEqual(['active-rule']);
    });
  });

  describe('Time window validation', () => {
    it('should identify active silence within time window', () => {
      const now = Date.now();
      const silence: Silence = {
        id: 's1',
        startsAt: now - 1000,
        endsAt: now + 1000,
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test',
        comment: '',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(true);
    });

    it('should identify expired silence before start time', () => {
      const now = Date.now();
      const silence: Silence = {
        id: 's1',
        startsAt: now + 5000,
        endsAt: now + 10000,
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test',
        comment: '',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(false);
    });

    it('should identify expired silence after end time', () => {
      const now = Date.now();
      const silence: Silence = {
        id: 's1',
        startsAt: now - 10000,
        endsAt: now - 5000,
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test',
        comment: '',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(false);
    });

    it('should handle silence at exact boundaries', () => {
      const now = Date.now();
      const silence: Silence = {
        id: 's1',
        startsAt: now,
        endsAt: now + 5000,
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test',
        comment: '',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(true);
      expect(manager.isActive(silence, now + 5000)).toBe(true);
      expect(manager.isActive(silence, now + 5001)).toBe(false);
    });
  });

  describe('Cron expression matching', () => {
    it('should support daily cron window', () => {
      const now = new Date('2024-01-15T03:00:00Z').getTime();
      const silence: Silence = {
        id: 'cron1',
        startsAt: now - 86400000 * 7,
        endsAt: now + 86400000 * 7,
        cronExpression: '0 2 * * *',
        matchers: { ruleIds: ['nightly-job'] },
        createdBy: 'system',
        comment: 'Daily maintenance window 2-4am',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(true);
    });

    it('should not match outside cron window', () => {
      const now = new Date('2024-01-15T15:00:00Z').getTime();
      const silence: Silence = {
        id: 'cron1',
        startsAt: now - 86400000 * 7,
        endsAt: now + 86400000 * 7,
        cronExpression: '0 2 * * *',
        matchers: { ruleIds: ['nightly-job'] },
        createdBy: 'system',
        comment: 'Daily maintenance window',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(false);
    });

    it('should fall back to time window if cron is invalid', () => {
      const now = Date.now();
      const silence: Silence = {
        id: 'cron-bad',
        startsAt: now - 1000,
        endsAt: now + 1000,
        cronExpression: 'invalid cron !!!',
        matchers: { ruleIds: ['rule-1'] },
        createdBy: 'test',
        comment: '',
        createdAt: now,
        updatedAt: now
      };

      expect(manager.isActive(silence, now)).toBe(true);
    });
  });

  describe('Matcher rules', () => {
    it('should match by exact rule ID', () => {
      const now = Date.now();
      const silence = manager.createSilence({
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-1', 'rule-2'] }
      });

      const alert1 = createAlert({ ruleId: 'rule-1' });
      const alert2 = createAlert({ ruleId: 'rule-2' });
      const alert3 = createAlert({ ruleId: 'rule-3' });

      expect(manager.checkSilenced(alert1, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(alert2, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(alert3, undefined, now)).toBeNull();
    });

    it('should match by wildcard rule ID pattern', () => {
      const now = Date.now();
      manager.createSilence({
        durationSeconds: 3600,
        matchers: { ruleIds: ['error-*', 'warn-*'] }
      });

      expect(manager.checkSilenced(createAlert({ ruleId: 'error-db' }), undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(createAlert({ ruleId: 'warn-rate' }), undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(createAlert({ ruleId: 'info-login' }), undefined, now)).toBeNull();
    });

    it('should match by labels with exact values', () => {
      const now = Date.now();
      manager.createSilence({
        durationSeconds: 3600,
        matchers: { labels: { env: 'staging', component: 'api' } }
      });

      const alertMatch = createAlert({
        logs: [createLog(now, { env: 'staging', component: 'api', requestId: '123' })]
      });
      const alertPartial = createAlert({
        logs: [createLog(now, { env: 'staging', component: 'worker' })]
      });
      const alertNoMatch = createAlert({
        logs: [createLog(now, { env: 'production' })]
      });

      expect(manager.checkSilenced(alertMatch, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(alertPartial, undefined, now)).toBeNull();
      expect(manager.checkSilenced(alertNoMatch, undefined, now)).toBeNull();
    });

    it('should match by labels with regex pattern', () => {
      const now = Date.now();
      manager.createSilence({
        durationSeconds: 3600,
        matchers: { labels: { error_code: '/^5[0-9]{2}$/' } }
      });

      const alert500 = createAlert({
        logs: [createLog(now, { error_code: '500' })]
      });
      const alert503 = createAlert({
        logs: [createLog(now, { error_code: '503' })]
      });
      const alert404 = createAlert({
        logs: [createLog(now, { error_code: '404' })]
      });

      expect(manager.checkSilenced(alert500, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(alert503, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(alert404, undefined, now)).toBeNull();
    });

    it('should match by severity label', () => {
      const now = Date.now();
      manager.createSilence({
        durationSeconds: 3600,
        matchers: { labels: { severity: 'info' } }
      });

      const infoAlert = createAlert({ severity: 'info' });
      const warnAlert = createAlert({ severity: 'warning' });

      expect(manager.checkSilenced(infoAlert, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(warnAlert, undefined, now)).toBeNull();
    });

    it('should match by groupKey label', () => {
      const now = Date.now();
      manager.createSilence({
        durationSeconds: 3600,
        matchers: { labels: { groupKey: 'db-cluster-1' } }
      });

      const groupedAlert = createAlert({ groupKey: 'db-cluster-1' });
      const otherAlert = createAlert({ groupKey: 'db-cluster-2' });

      expect(manager.checkSilenced(groupedAlert, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(otherAlert, undefined, now)).toBeNull();
    });

    it('should combine rule IDs and labels (AND logic)', () => {
      const now = Date.now();
      manager.createSilence({
        startsAt: now,
        durationSeconds: 3600,
        matchers: {
          ruleIds: ['rule-db'],
          labels: { env: 'staging' }
        }
      });

      const matchBoth = createAlert({
        ruleId: 'rule-db',
        logs: [createLog(now, { env: 'staging' })]
      });
      const matchRuleOnly = createAlert({
        ruleId: 'rule-db',
        logs: [createLog(now, { env: 'production' })]
      });
      const matchLabelOnly = createAlert({
        ruleId: 'rule-api',
        logs: [createLog(now, { env: 'staging' })]
      });

      expect(manager.checkSilenced(matchBoth, undefined, now)).not.toBeNull();
      expect(manager.checkSilenced(matchRuleOnly, undefined, now)).toBeNull();
      expect(manager.checkSilenced(matchLabelOnly, undefined, now)).toBeNull();
    });
  });

  describe('Integration with alert matching', () => {
    it('should not match expired silence', () => {
      const now = Date.now();
      manager.createSilence({
        startsAt: now - 10000,
        endsAt: now - 5000,
        matchers: { ruleIds: ['rule-expired'] }
      });

      const alert = createAlert({ ruleId: 'rule-expired' });
      expect(manager.checkSilenced(alert, undefined, now)).toBeNull();
    });

    it('should not match not-yet-started silence', () => {
      const now = Date.now();
      manager.createSilence({
        startsAt: now + 5000,
        endsAt: now + 10000,
        matchers: { ruleIds: ['rule-future'] }
      });

      const alert = createAlert({ ruleId: 'rule-future' });
      expect(manager.checkSilenced(alert, undefined, now)).toBeNull();
    });

    it('should get matching silences for a rule', () => {
      const now = Date.now();
      manager.createSilence({
        startsAt: now,
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-1'] },
        comment: 'silence-a'
      });
      manager.createSilence({
        startsAt: now,
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-1', 'rule-2'] },
        comment: 'silence-b'
      });
      manager.createSilence({
        startsAt: now,
        durationSeconds: 3600,
        matchers: { ruleIds: ['rule-3'] },
        comment: 'silence-c'
      });

      const matching = manager.getMatchingSilences('rule-1', undefined, now);
      expect(matching.length).toBe(2);
      expect(matching.map(s => s.comment).sort()).toEqual(['silence-a', 'silence-b']);
    });
  });

  describe('YAML config loading', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silences-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should load silences from YAML file', async () => {
      const silenceFile = path.join(tempDir, 'silences.yaml');
      const now = Date.now();

      const silencesData = [
        {
          id: 'yaml-silence-1',
          duration_seconds: 7200,
          matchers: {
            rule_ids: ['rule-from-yaml']
          },
          created_by: 'yaml-config',
          comment: 'Loaded from YAML'
        },
        {
          id: 'yaml-silence-2',
          starts_at: now,
          ends_at: now + 3600 * 1000,
          cron_expression: '0 0 * * 0',
          matchers: {
            labels: { env: 'test' }
          },
          comment: 'Sunday maintenance'
        }
      ];

      fs.writeFileSync(silenceFile, yaml.dump(silencesData));

      const loaded = await manager.loadSilenceFiles([silenceFile]);
      expect(loaded.length).toBe(2);
      expect(manager.getSilence('yaml-silence-1')).toBeDefined();
      expect(manager.getSilence('yaml-silence-2')?.cronExpression).toBe('0 0 * * 0');

      const match = manager.checkSilenced(
        createAlert({ ruleId: 'rule-from-yaml' }),
        undefined
      );
      expect(match).not.toBeNull();
      expect(match!.id).toBe('yaml-silence-1');
    });

    it('should handle silence file with silences wrapper key', async () => {
      const silenceFile = path.join(tempDir, 'silences.yaml');

      const data = {
        silences: [
          {
            id: 'wrapped-silence',
            duration_seconds: 3600,
            matchers: { rule_ids: ['wrapped-rule'] }
          }
        ]
      };

      fs.writeFileSync(silenceFile, yaml.dump(data));
      const loaded = await manager.loadSilenceFiles([silenceFile]);

      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('wrapped-silence');
    });

    it('should warn on missing file', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const loaded = await manager.loadSilenceFiles([path.join(tempDir, 'nonexistent.yaml')]);
      expect(loaded.length).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
