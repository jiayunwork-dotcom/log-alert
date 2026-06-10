import { TemplateEngine } from '../index';
import { TriggeredAlert, AlertRule, StructuredLog, Severity } from '../../types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createLog(timestamp: number, overrides: Partial<StructuredLog> = {}): StructuredLog {
  return {
    timestamp,
    level: 'ERROR',
    source: 'app-server',
    message: 'Database connection failed: timeout after 30s',
    fields: { component: 'db', request_id: 'req-abc123', host: 'db-01' },
    raw: '',
    ...overrides
  };
}

function createAlert(overrides: Partial<TriggeredAlert> = {}): TriggeredAlert {
  const now = Date.now();
  return {
    id: 'alert-001',
    ruleId: overrides.ruleId || 'rule-db-conn',
    ruleName: overrides.ruleName || 'Database Connection Error',
    severity: (overrides.severity as Severity) || 'critical',
    originalSeverity: (overrides.originalSeverity as Severity) || overrides.severity as Severity || 'critical',
    triggeredAt: overrides.triggeredAt || now,
    logs: overrides.logs || [
      createLog(now - 2000),
      createLog(now - 1000),
      createLog(now)
    ],
    extraFields: overrides.extraFields || {},
    groupKey: overrides.groupKey,
    sequenceKey: overrides.sequenceKey,
    isRecovery: overrides.isRecovery,
    resolved: overrides.resolved,
    resolvedAt: overrides.resolvedAt
  };
}

function createRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: overrides.id || 'rule-db-conn',
    name: overrides.name || 'Database Connection Error',
    description: overrides.description || 'Triggers when database connection errors exceed threshold',
    severity: (overrides.severity as Severity) || 'critical',
    priority: overrides.priority || 10,
    enabled: true,
    condition: overrides.condition || { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
    actions: overrides.actions || []
  };
}

describe('TemplateEngine', () => {
  let engine: TemplateEngine;

  beforeEach(() => {
    engine = new TemplateEngine();
  });

  afterEach(() => {
    engine.stop();
  });

  describe('Builtin templates', () => {
    it('should load all 3 builtin templates on initialization', () => {
      const templates = engine.getAllTemplates();
      const builtinIds = templates.filter(t => t.isBuiltin).map(t => t.id);

      expect(builtinIds).toContain('simple');
      expect(builtinIds).toContain('detailed');
      expect(builtinIds).toContain('json');
      expect(templates.length).toBeGreaterThanOrEqual(3);
    });

    it('should have correct metadata for builtins', () => {
      const simple = engine.getTemplate('simple');
      const detailed = engine.getTemplate('detailed');
      const json = engine.getTemplate('json');

      expect(simple?.isBuiltin).toBe(true);
      expect(simple?.name).toBe('Simple');

      expect(detailed?.isBuiltin).toBe(true);
      expect(detailed?.name).toBe('Detailed');

      expect(json?.isBuiltin).toBe(true);
      expect(json?.name).toBe('JSON');
    });
  });

  describe('Variable substitution and rendering', () => {
    it('should render simple template with all variables', () => {
      const alert = createAlert();
      const rule = createRule();
      const rendered = engine.renderAlert('simple', alert, rule);

      expect(rendered).toContain('[critical]');
      expect(rendered).toContain('Database Connection Error');
      expect(rendered).toContain('rule-db-conn');
      expect(rendered).toContain('3 logs matched');
    });

    it('should render detailed template with sections', () => {
      const alert = createAlert({
        groupKey: 'db-cluster-01'
      });
      const rule = createRule({
        description: 'Triggers when database connection errors exceed threshold'
      });
      const rendered = engine.renderAlert('detailed', alert, rule);

      expect(rendered).toContain('=== Alert Triggered ===');
      expect(rendered).toContain('Severity: critical');
      expect(rendered).toContain('Rule: Database Connection Error');
      expect(rendered).toContain('Priority: 10');
      expect(rendered).toContain('Description: Triggers when database connection errors exceed threshold');
      expect(rendered).toContain('Logs Matched: 3');
      expect(rendered).toContain('Group Key: db-cluster-01');
      expect(rendered).toContain('--- Matched Logs');
      expect(rendered).toContain('Database connection failed');
      expect(rendered).toContain('component: db');
      expect(rendered).toContain('--- Timeline ---');
      expect(rendered).toContain('Alert ID: alert-001');
    });

    it('should render json template with valid JSON structure', () => {
      const alert = createAlert();
      const rule = createRule();
      const rendered = engine.renderAlert('json', alert, rule);

      expect(() => JSON.parse(rendered)).not.toThrow();

      const parsed = JSON.parse(rendered);
      expect(parsed.alert.id).toBe('alert-001');
      expect(parsed.alert.ruleId).toBe('rule-db-conn');
      expect(parsed.alert.ruleName).toBe('Database Connection Error');
      expect(parsed.alert.severity).toBe('critical');
      expect(parsed.alert.logsCount).toBe(3);
      expect(parsed.rule.id).toBe('rule-db-conn');
      expect(parsed.rule.priority).toBe(10);
      expect(parsed.logs.length).toBe(3);
      expect(parsed.logs[0].fields.component).toBe('db');
    });

    it('should render recovery alert correctly', () => {
      const alert = createAlert({
        isRecovery: true,
        resolved: true,
        logs: []
      });
      const rule = createRule();

      const simple = engine.renderAlert('simple', alert, rule);
      const detailed = engine.renderAlert('detailed', alert, rule);
      const jsonRendered = engine.renderAlert('json', alert, rule);

      expect(detailed).toContain('RECOVERY NOTIFICATION');

      const parsed = JSON.parse(jsonRendered);
      expect(parsed.alert.isRecovery).toBe(true);
      expect(parsed.alert.resolved).toBe(true);
      expect(parsed.alert.logsCount).toBe(0);
    });

    it('should include sequenceKey in rendered output', () => {
      const alert = createAlert({
        sequenceKey: 'seq-user-42'
      });
      const rule = createRule();

      const rendered = engine.renderAlert('detailed', alert, rule);
      expect(rendered).toContain('Sequence Key: seq-user-42');
    });

    it('should format triggeredAt timestamp', () => {
      const fixedTime = new Date('2024-01-15T10:30:00Z').getTime();
      const alert = createAlert({ triggeredAt: fixedTime });
      const rule = createRule();

      const rendered = engine.renderAlert('simple', alert, rule);
      expect(rendered).toContain('2024-01-15T10:30:00.000Z');
    });

    it('should format triggeredAt timestamp with timezone', () => {
      const fixedTime = new Date('2024-01-15T10:30:00Z').getTime();
      const alert = createAlert({ triggeredAt: fixedTime });
      const rule = createRule();

      const rendered = engine.renderAlert('simple', alert, rule, 'Asia/Shanghai');
      expect(rendered).toContain('06:30:00');
    });
  });

  describe('Handlebars helpers', () => {
    it('should support formatDate helper', () => {
      const alert = createAlert({ triggeredAt: 1705317000000 });
      const rule = createRule();

      const ctx = engine.buildRenderContext(alert, rule);
      const result = (engine as any).handlebars.compile('{{formatDate alert.triggeredAtMs "iso"}}')(ctx);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should support truncate helper', () => {
      const alert = createAlert({
        logs: [createLog(Date.now(), { message: 'A very long message that should be truncated for display purposes' })]
      });
      const rule = createRule();
      const ctx = engine.buildRenderContext(alert, rule);

      const result = (engine as any).handlebars.compile('{{truncate firstLog.message 20}}')(ctx);
      expect(result).toBe('A very long message ...');
    });

    it('should support json helper', () => {
      const alert = createAlert();
      const rule = createRule();
      const ctx = engine.buildRenderContext(alert, rule);

      const result = (engine as any).handlebars.compile('{{json alert.logsCount}}')(ctx);
      expect(result).toBe('3');
    });

    it('should support upper and lower helpers', () => {
      const alert = createAlert();
      const rule = createRule();
      const ctx = engine.buildRenderContext(alert, rule);

      const upper = (engine as any).handlebars.compile('{{upper alert.severity}}')(ctx);
      const lower = (engine as any).handlebars.compile('{{lower alert.severity}}')(ctx);

      expect(upper).toBe('CRITICAL');
      expect(lower).toBe('critical');
    });

    it('should support ifEquals helper', () => {
      const alert = createAlert();
      const rule = createRule();
      const ctx = engine.buildRenderContext(alert, rule);

      const tmpl = '{{#ifEquals alert.severity "critical"}}HIGH{{else}}LOW{{/ifEquals}}';
      const result = (engine as any).handlebars.compile(tmpl)(ctx);
      expect(result).toBe('HIGH');
    });
  });

  describe('Custom templates from directory', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should load custom .hbs templates from directory', async () => {
      const customTplPath = path.join(tempDir, 'my-template.hbs');
      fs.writeFileSync(
        customTplPath,
        '{{! Custom Alert | My custom description }}\nALERT: {{alert.ruleName}} - {{alert.logsCount}} errors'
      );

      const loaded = await engine.loadCustomTemplates(tempDir);
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('my-template');
      expect(loaded[0].name).toBe('Custom Alert');
      expect(loaded[0].description).toBe('My custom description');
      expect(loaded[0].isBuiltin).toBe(false);

      expect(engine.hasTemplate('my-template')).toBe(true);
      expect(engine.getTemplate('my-template')?.filePath).toBe(customTplPath);
    });

    it('should load custom .handlebars templates from directory', async () => {
      const customTplPath = path.join(tempDir, 'another.handlebars');
      fs.writeFileSync(customTplPath, 'Custom: {{alert.id}}');

      const loaded = await engine.loadCustomTemplates(tempDir);
      expect(loaded.length).toBe(1);
      expect(loaded[0].id).toBe('another');
    });

    it('should render custom template correctly', async () => {
      const customTplPath = path.join(tempDir, 'slack.hbs');
      fs.writeFileSync(
        customTplPath,
        ':red_circle: *{{alert.ruleName}}*\nSeverity: {{alert.severity}}\nCount: {{alert.logsCount}}'
      );

      await engine.loadCustomTemplates(tempDir);

      const alert = createAlert();
      const rule = createRule();
      const rendered = engine.renderAlert('slack', alert, rule);

      expect(rendered).toContain(':red_circle: *Database Connection Error*');
      expect(rendered).toContain('Severity: critical');
      expect(rendered).toContain('Count: 3');
    });

    it('should render template without metadata header', async () => {
      const customTplPath = path.join(tempDir, 'plain.hbs');
      fs.writeFileSync(customTplPath, '{{alert.ruleId}}@{{alert.triggeredAtMs}}');

      await engine.loadCustomTemplates(tempDir);

      const alert = createAlert({ triggeredAt: 1234567890 });
      const rule = createRule();
      const rendered = engine.renderAlert('plain', alert, rule);

      expect(rendered).toBe('rule-db-conn@1234567890');
    });

    it('should not crash on missing templates directory', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const loaded = await engine.loadCustomTemplates(path.join(tempDir, 'non-existent'));
      expect(loaded.length).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should fall back to default template if requested template missing', () => {
      const alert = createAlert();
      const rule = createRule();

      const rendered = engine.renderAlert('non-existent-template', alert, rule);
      expect(rendered).toBeDefined();
      expect(rendered.length).toBeGreaterThan(0);
    });

    it('should support hot reloading of templates', (done) => {
      const customTplPath = path.join(tempDir, 'hot.hbs');
      fs.writeFileSync(customTplPath, 'Version 1: {{alert.ruleName}}');

      engine.loadCustomTemplates(tempDir).then(() => {
        const alert = createAlert();
        const rule = createRule();

        const v1 = engine.renderAlert('hot', alert, rule);
        expect(v1).toContain('Version 1');

        setTimeout(() => {
          fs.writeFileSync(customTplPath, 'Version 2: {{alert.ruleName}} (UPDATED)');
        }, 50);

        setTimeout(() => {
          const v2 = engine.renderAlert('hot', alert, rule);
          expect(v2).toContain('Version 2');
          expect(v2).toContain('UPDATED');
          done();
        }, 500);
      });
    }, 2000);
  });

  describe('Preview functionality', () => {
    it('should render preview with mock data', () => {
      const previewSimple = engine.preview('simple', {});
      expect(previewSimple).toContain('[warning]');
      expect(previewSimple).toContain('Preview Alert Rule');

      const previewJson = engine.preview('json', {});
      expect(() => JSON.parse(previewJson)).not.toThrow();
      const parsed = JSON.parse(previewJson);
      expect(parsed.alert.id).toContain('preview');
      expect(parsed.logs.length).toBeGreaterThan(0);
    });

    it('should render preview with custom alert overrides', () => {
      const result = engine.preview('simple', {
        ruleId: 'custom-rule',
        ruleName: 'My Custom Rule',
        severity: 'info',
        logs: [
          createLog(Date.now(), { message: 'Custom log message' }),
          createLog(Date.now() + 1000, { message: 'Another log' })
        ]
      });

      expect(result).toContain('[info]');
      expect(result).toContain('My Custom Rule');
      expect(result).toContain('custom-rule');
      expect(result).toContain('2 logs matched');
    });

    it('should include custom rule info in preview', () => {
      const result = engine.preview('detailed', {
        ruleName: 'XYZ Rule',
        ruleId: 'rule-xyz',
        rule: {
          id: 'rule-xyz',
          name: 'XYZ Rule',
          description: 'This rule monitors XYZ system',
          priority: 999
        }
      });

      expect(result).toContain('Rule: XYZ Rule');
      expect(result).toContain('ID: rule-xyz');
      expect(result).toContain('Description: This rule monitors XYZ system');
      expect(result).toContain('Priority: 999');
    });
  });

  describe('Build render context', () => {
    it('should build context with all required fields', () => {
      const fixedTime = Date.now();
      const alert = createAlert({
        triggeredAt: fixedTime,
        groupKey: 'grp-1',
        sequenceKey: 'seq-1'
      });
      const rule = createRule({ priority: 25 });

      const ctx = engine.buildRenderContext(alert, rule);

      expect(ctx.alert.id).toBe('alert-001');
      expect(ctx.alert.ruleId).toBe('rule-db-conn');
      expect(ctx.alert.severity).toBe('critical');
      expect(ctx.alert.triggeredAtMs).toBe(fixedTime);
      expect(ctx.alert.logsCount).toBe(3);
      expect(ctx.alert.groupKey).toBe('grp-1');
      expect(ctx.alert.sequenceKey).toBe('seq-1');

      expect(ctx.rule.id).toBe('rule-db-conn');
      expect(ctx.rule.priority).toBe(25);

      expect(ctx.logs.length).toBe(3);
      expect(ctx.firstLog).toBeDefined();
      expect(ctx.lastLog).toBeDefined();
      expect(ctx.firstLog?.fields.component).toBe('db');
    });

    it('should handle empty logs array gracefully', () => {
      const alert = createAlert({ logs: [] });
      const rule = createRule();

      const ctx = engine.buildRenderContext(alert, rule);

      expect(ctx.alert.logsCount).toBe(0);
      expect(ctx.logs.length).toBe(0);
      expect(ctx.firstLog).toBeUndefined();
      expect(ctx.lastLog).toBeUndefined();
    });

    it('should use rule defaults when rule not provided', () => {
      const alert = createAlert();
      const ctx = engine.buildRenderContext(alert);

      expect(ctx.rule.id).toBe(alert.ruleId);
      expect(ctx.rule.name).toBe(alert.ruleName);
      expect(ctx.rule.severity).toBe(alert.severity);
      expect(ctx.rule.priority).toBe(100);
    });
  });

  describe('hasTemplate and getTemplate', () => {
    it('should report correct template existence', () => {
      expect(engine.hasTemplate('simple')).toBe(true);
      expect(engine.hasTemplate('detailed')).toBe(true);
      expect(engine.hasTemplate('json')).toBe(true);
      expect(engine.hasTemplate('non-existent')).toBe(false);
      expect(engine.hasTemplate('')).toBe(false);
    });

    it('should return undefined for missing template', () => {
      expect(engine.getTemplate('missing')).toBeUndefined();
    });
  });
});
