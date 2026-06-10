import { AlertTemplate, TemplateRenderContext, TriggeredAlert, AlertRule, Severity, StructuredLog } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import Handlebars from 'handlebars';

const BUILTIN_TEMPLATES: Record<string, { name: string; description?: string; content: string }> = {
  simple: {
    name: 'Simple',
    description: '单行摘要模板，适合简洁通知',
    content: `[{{alert.severity}}] {{alert.ruleName}} - {{alert.ruleId}} triggered at {{alert.triggeredAt}}, {{alert.logsCount}} logs matched`
  },
  detailed: {
    name: 'Detailed',
    description: '详细模板，包含规则详情、匹配日志和时间线',
    content: `=== Alert Triggered ===
Severity: {{alert.severity}}
Rule: {{alert.ruleName}} ({{alert.ruleId}})
Priority: {{rule.priority}}
Description: {{rule.description}}
Triggered At: {{alert.triggeredAt}}
Logs Matched: {{alert.logsCount}}
{{#if alert.groupKey}}Group Key: {{alert.groupKey}}{{/if}}
{{#if alert.sequenceKey}}Sequence Key: {{alert.sequenceKey}}{{/if}}
{{#if alert.isRecovery}}** RECOVERY NOTIFICATION **{{/if}}

--- Rule Info ---
ID: {{rule.id}}
Name: {{rule.name}}
Severity: {{rule.severity}}
Priority: {{rule.priority}}
Description: {{rule.description}}

--- Matched Logs ({{alert.logsCount}} total) ---
{{#each logs}}
  [{{this.timestamp}}] [{{this.level}}] {{this.source}}: {{this.message}}
  {{#each this.fields}}
    {{@key}}: {{this}}
  {{/each}}
{{/each}}

--- Timeline ---
First Log: {{#if firstLog}}{{firstLog.timestamp}}{{else}}N/A{{/if}}
Last Log: {{#if lastLog}}{{lastLog.timestamp}}{{else}}N/A{{/if}}
Alert ID: {{alert.id}}`
  },
  json: {
    name: 'JSON',
    description: '结构化JSON模板，适合机器消费',
    content: `{
  "alert": {
    "id": "{{alert.id}}",
    "ruleId": "{{alert.ruleId}}",
    "ruleName": "{{alert.ruleName}}",
    "severity": "{{alert.severity}}",
    "triggeredAt": "{{alert.triggeredAt}}",
    "triggeredAtMs": {{alert.triggeredAtMs}},
    "logsCount": {{alert.logsCount}},
    {{#if alert.groupKey}}"groupKey": "{{alert.groupKey}}",{{/if}}
    {{#if alert.sequenceKey}}"sequenceKey": "{{alert.sequenceKey}}",{{/if}}
    "isRecovery": {{#if alert.isRecovery}}true{{else}}false{{/if}},
    "resolved": {{#if alert.resolved}}true{{else}}false{{/if}}
  },
  "rule": {
    "id": "{{rule.id}}",
    "name": "{{rule.name}}",
    "severity": "{{rule.severity}}",
    "priority": {{rule.priority}},
    "description": "{{rule.description}}"
  },
  "logsCount": {{alert.logsCount}},
  "logs": [
    {{#each logs}}
    {
      "timestamp": {{this.timestamp}},
      "level": "{{this.level}}",
      "source": "{{this.source}}",
      "message": "{{this.message}}",
      "fields": {
        {{#each this.fields}}
        "{{@key}}": "{{this}}"{{#unless @last}},{{/unless}}
        {{/each}}
      }
    }{{#unless @last}},{{/unless}}
    {{/each}}
  ]
}`
  }
};

export interface TemplateEngineOptions {
  defaultTemplateId?: string;
  templatesDir?: string;
  onTemplatesReloaded?: (templates: AlertTemplate[]) => void;
}

export class TemplateEngine {
  private templates: Map<string, AlertTemplate> = new Map();
  private compiledTemplates: Map<string, Handlebars.TemplateDelegate> = new Map();
  private templatesDir?: string;
  private watcher?: chokidar.FSWatcher;
  private isReloading: boolean = false;
  private defaultTemplateId: string;
  private options: TemplateEngineOptions;
  private handlebars: typeof Handlebars;

  constructor(options: TemplateEngineOptions = {}) {
    this.options = options;
    this.defaultTemplateId = options.defaultTemplateId || 'simple';
    this.templatesDir = options.templatesDir;
    this.handlebars = Handlebars.create();
    this.registerHelpers();
    this.loadBuiltinTemplates();
  }

  private registerHelpers(): void {
    this.handlebars.registerHelper('formatDate', (timestamp: any, format: string) => {
      const ts = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
      if (isNaN(ts)) return String(timestamp);
      const date = new Date(ts);
      if (format === 'iso') return date.toISOString();
      if (format === 'local') return date.toLocaleString();
      if (format === 'time') return date.toTimeString();
      if (format === 'date') return date.toDateString();
      return date.toISOString();
    });

    this.handlebars.registerHelper('truncate', (text: string, length: number) => {
      if (!text) return '';
      const str = String(text);
      if (str.length <= length) return str;
      return str.substring(0, length) + '...';
    });

    this.handlebars.registerHelper('json', (obj: any) => {
      try {
        return JSON.stringify(obj, null, 2);
      } catch {
        return String(obj);
      }
    });

    this.handlebars.registerHelper('upper', (text: string) => String(text || '').toUpperCase());
    this.handlebars.registerHelper('lower', (text: string) => String(text || '').toLowerCase());

    this.handlebars.registerHelper('ifEquals', function(this: any, a: any, b: any, options: any) {
      return (a === b) ? options.fn(this) : options.inverse(this);
    });
  }

  private loadBuiltinTemplates(): void {
    const now = Date.now();
    for (const [id, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
      const template: AlertTemplate = {
        id,
        name: tpl.name,
        description: tpl.description,
        content: tpl.content,
        isBuiltin: true,
        loadedAt: now
      };
      this.templates.set(id, template);
      this.compileTemplate(id, template.content);
    }
  }

  async loadCustomTemplates(dir?: string): Promise<AlertTemplate[]> {
    const templatesDir = dir || this.templatesDir;
    if (!templatesDir) return [];

    this.templatesDir = templatesDir;
    const resolvedDir = path.resolve(templatesDir);

    if (!fs.existsSync(resolvedDir)) {
      console.warn(`[TemplateEngine] Templates directory not found: ${resolvedDir}`);
      return [];
    }

    const loaded: AlertTemplate[] = [];
    const files = fs.readdirSync(resolvedDir).filter(f => f.endsWith('.hbs') || f.endsWith('.handlebars'));

    for (const file of files) {
      try {
        const filePath = path.join(resolvedDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const id = path.basename(file).replace(/\.(hbs|handlebars)$/, '');

        let name = id;
        let description: string | undefined;

        const firstLine = content.split('\n')[0];
        if (firstLine.startsWith('{{!')) {
          const meta = firstLine.replace(/\{\{!\s*|\s*\}\}/g, '').trim();
          const parts = meta.split('|').map(s => s.trim());
          if (parts[0]) name = parts[0];
          if (parts[1]) description = parts[1];
        }

        const template: AlertTemplate = {
          id,
          name,
          description,
          content,
          isBuiltin: false,
          filePath,
          loadedAt: Date.now()
        };

        this.templates.set(id, template);
        this.compileTemplate(id, content);
        loaded.push(template);
      } catch (e) {
        console.error(`[TemplateEngine] Failed to load template ${file}:`, e);
      }
    }

    this.setupWatcher(resolvedDir);
    console.info(`[TemplateEngine] Loaded ${loaded.length} custom templates from ${resolvedDir}`);

    if (this.options.onTemplatesReloaded) {
      this.options.onTemplatesReloaded(this.getAllTemplates());
    }

    return loaded;
  }

  private setupWatcher(dir: string): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(dir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    this.watcher.on('change', (filePath) => this.handleTemplateChange(filePath));
    this.watcher.on('add', (filePath) => this.handleTemplateChange(filePath));
    this.watcher.on('unlink', (filePath) => {
      const id = path.basename(filePath).replace(/\.(hbs|handlebars)$/, '');
      const existing = this.templates.get(id);
      if (existing && !existing.isBuiltin) {
        this.templates.delete(id);
        this.compiledTemplates.delete(id);
        console.info(`[TemplateEngine] Removed template ${id}`);
        this.notifyReloaded();
      }
    });
  }

  private handleTemplateChange(filePath: string): void {
    if (this.isReloading) return;
    this.isReloading = true;

    setTimeout(async () => {
      try {
        if (!fs.existsSync(filePath)) return;

        const content = fs.readFileSync(filePath, 'utf8');
        const id = path.basename(filePath).replace(/\.(hbs|handlebars)$/, '');

        let name = id;
        let description: string | undefined;
        const firstLine = content.split('\n')[0];
        if (firstLine.startsWith('{{!')) {
          const meta = firstLine.replace(/\{\{!\s*|\s*\}\}/g, '').trim();
          const parts = meta.split('|').map(s => s.trim());
          if (parts[0]) name = parts[0];
          if (parts[1]) description = parts[1];
        }

        const template: AlertTemplate = {
          id,
          name,
          description,
          content,
          isBuiltin: false,
          filePath,
          loadedAt: Date.now()
        };

        this.templates.set(id, template);
        this.compileTemplate(id, content);
        console.info(`[TemplateEngine] Reloaded template ${id}`);
        this.notifyReloaded();
      } catch (e) {
        console.error(`[TemplateEngine] Error reloading template ${filePath}:`, e);
      } finally {
        this.isReloading = false;
      }
    }, 100);
  }

  private notifyReloaded(): void {
    if (this.options.onTemplatesReloaded) {
      this.options.onTemplatesReloaded(this.getAllTemplates());
    }
  }

  private compileTemplate(id: string, content: string): void {
    try {
      const compiled = this.handlebars.compile(content, { noEscape: true });
      this.compiledTemplates.set(id, compiled);
    } catch (e) {
      console.error(`[TemplateEngine] Failed to compile template ${id}:`, e);
      throw e;
    }
  }

  hasTemplate(templateId: string): boolean {
    return this.templates.has(templateId);
  }

  getTemplate(templateId: string): AlertTemplate | undefined {
    return this.templates.get(templateId);
  }

  getAllTemplates(): AlertTemplate[] {
    return Array.from(this.templates.values()).sort((a, b) => {
      if (a.isBuiltin !== b.isBuiltin) return a.isBuiltin ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  buildRenderContext(alert: TriggeredAlert, rule?: AlertRule, timezone: string = 'UTC'): TemplateRenderContext {
    const formatTime = (ts: number): string => {
      try {
        const date = new Date(ts);
        if (timezone && timezone !== 'UTC') {
          return new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).format(date);
        }
        return date.toISOString();
      } catch {
        return new Date(ts).toISOString();
      }
    };

    const ruleData = rule || {
      id: alert.ruleId,
      name: alert.ruleName,
      description: '',
      severity: alert.severity,
      priority: 100
    };

    return {
      alert: {
        id: alert.id,
        ruleName: alert.ruleName,
        ruleId: alert.ruleId,
        severity: alert.severity,
        triggeredAt: formatTime(alert.triggeredAt),
        triggeredAtMs: alert.triggeredAt,
        logs: alert.logs,
        logsCount: alert.logs.length,
        groupKey: alert.groupKey,
        sequenceKey: alert.sequenceKey,
        isRecovery: alert.isRecovery,
        resolved: alert.resolved
      },
      rule: {
        id: ruleData.id,
        name: ruleData.name,
        description: ruleData.description,
        severity: ruleData.severity,
        priority: ruleData.priority
      },
      logs: alert.logs,
      firstLog: alert.logs[0],
      lastLog: alert.logs[alert.logs.length - 1]
    };
  }

  render(templateId: string, context: TemplateRenderContext): string {
    const id = templateId || this.defaultTemplateId;
    const compiled = this.compiledTemplates.get(id);

    if (!compiled) {
      console.warn(`[TemplateEngine] Template ${id} not found, falling back to ${this.defaultTemplateId}`);
      const fallback = this.compiledTemplates.get(this.defaultTemplateId);
      if (!fallback) {
        return JSON.stringify(context);
      }
      return fallback(context);
    }

    try {
      return compiled(context);
    } catch (e) {
      console.error(`[TemplateEngine] Error rendering template ${id}:`, e);
      return JSON.stringify(context);
    }
  }

  renderAlert(templateId: string, alert: TriggeredAlert, rule?: AlertRule, timezone: string = 'UTC'): string {
    const context = this.buildRenderContext(alert, rule, timezone);
    return this.render(templateId, context);
  }

  preview(templateId: string, alertData: Partial<TriggeredAlert> & { rule?: Partial<AlertRule> }, timezone: string = 'UTC'): string {
    const defaultLog: StructuredLog = {
      timestamp: Date.now(),
      level: 'ERROR',
      source: 'test',
      message: 'Sample error message for preview',
      fields: { component: 'api', requestId: 'req-123' },
      raw: ''
    };

    const mockAlert: TriggeredAlert = {
      id: alertData.id || 'alert-preview-001',
      ruleId: alertData.ruleId || 'rule-preview',
      ruleName: alertData.ruleName || 'Preview Alert Rule',
      severity: (alertData.severity as Severity) || 'warning',
      originalSeverity: (alertData.originalSeverity as Severity) || alertData.severity as Severity || 'warning',
      triggeredAt: alertData.triggeredAt || Date.now(),
      logs: alertData.logs && alertData.logs.length > 0 ? alertData.logs : [defaultLog],
      extraFields: alertData.extraFields || {},
      resolved: alertData.resolved,
      resolvedAt: alertData.resolvedAt,
      isRecovery: alertData.isRecovery,
      sequenceKey: alertData.sequenceKey,
      groupKey: alertData.groupKey
    };

    const mockRule: AlertRule = {
      id: alertData.rule?.id || mockAlert.ruleId,
      name: alertData.rule?.name || mockAlert.ruleName,
      description: alertData.rule?.description || 'This is a preview alert rule for template testing',
      severity: (alertData.rule?.severity as Severity) || mockAlert.severity,
      priority: alertData.rule?.priority || 50,
      enabled: true,
      condition: { type: 'simple', field: 'level', operator: '==', value: 'ERROR' },
      actions: []
    };

    return this.renderAlert(templateId, mockAlert, mockRule, timezone);
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
