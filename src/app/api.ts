import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { AppRuntime, rollbackToVersion } from './runtime';
import { AlertRule, RuleStats, TriggeredAlert, Severity, CreateSilenceRequest, ExtendSilenceRequest, TemplatePreviewRequest } from '../types';
import { inferFormat, InferredFormat } from '../inferrer';
import { LogParser } from '../parser';
import * as fs from 'fs';
import * as path from 'path';

function extractOperator(req: FastifyRequest): string {
  const header = req.headers['x-operator'];
  if (typeof header === 'string') return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return 'system';
}

export interface ApiServerOptions {
  port?: number;
}

export class ApiServer {
  private fastify: FastifyInstance;
  private runtime: AppRuntime;
  private port: number;
  private started: boolean = false;

  constructor(runtime: AppRuntime, options: ApiServerOptions = {}) {
    this.runtime = runtime;
    this.port = options.port || runtime.config.httpApiPort || 3000;
    this.fastify = Fastify({ logger: false });
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.fastify.register(fastifyCors, { origin: true });

    this.fastify.get('/health', async (_req, reply) => {
      const uptime = Date.now() - this.runtime.startTime;
      reply.send({
        status: 'ok',
        uptime_ms: uptime,
        uptime_seconds: Math.floor(uptime / 1000),
        processed_logs: this.runtime.processedCount,
        alerts_triggered: this.runtime.alertCount,
        alerts_silenced: this.runtime.silencedCount,
        active_sources: this.runtime.inputManager.getActiveSources(),
        rule_count: this.runtime.ruleManager.getRules().length,
        silence_count: this.runtime.silenceManager.getAllSilences(false).length,
        template_count: this.runtime.templateEngine.getAllTemplates().length
      });
    });

    this.fastify.get('/api/v1/rules', async (_req, reply) => {
      const rules = this.runtime.ruleManager.getRules().map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        severity: r.severity,
        priority: r.priority,
        enabled: r.enabled,
        cooldown_seconds: r.cooldownSeconds,
        recovery_notification: r.recoveryNotification
      }));
      reply.send({ rules });
    });

    this.fastify.get<{ Params: { id: string } }>('/api/v1/rules/:id', async (req, reply) => {
      const rule = this.runtime.ruleManager.getRule(req.params.id);
      if (!rule) {
        reply.code(404).send({ error: 'Rule not found' });
        return;
      }
      reply.send({ rule });
    });

    this.fastify.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
      '/api/v1/rules/:id/enabled',
      async (req, reply) => {
        const operator = extractOperator(req);
        const ok = this.runtime.ruleManager.setRuleEnabled(req.params.id, req.body.enabled, operator);
        if (!ok) {
          reply.code(404).send({ error: 'Rule not found' });
          return;
        }
        reply.send({ ok: true, enabled: req.body.enabled });
      }
    );

    this.fastify.post<{ Params: { id: string }; Body: { duration_seconds: number } }>(
      '/api/v1/rules/:id/suppress',
      async (req, reply) => {
        const operator = extractOperator(req);
        const ok = this.runtime.ruleManager.suppressRule(req.params.id, req.body.duration_seconds || 300, operator);
        if (!ok) {
          reply.code(404).send({ error: 'Rule not found' });
          return;
        }
        reply.send({ ok: true, suppressed_for_seconds: req.body.duration_seconds || 300 });
      }
    );

    this.fastify.post<{ Params: { id: string } }>(
      '/api/v1/rules/:id/reset',
      async (req, reply) => {
        const operator = extractOperator(req);
        this.runtime.ruleManager.resetRuleState(req.params.id, operator);
        reply.send({ ok: true });
      }
    );

    this.fastify.get<{ Querystring: { page?: string; page_size?: string } }>(
      '/api/v1/rules/versions',
      async (req, reply) => {
        const page = parseInt(req.query.page || '1', 10);
        const pageSize = parseInt(req.query.page_size || '20', 10);
        const result = this.runtime.versionManager.listVersions(page, pageSize);
        reply.send(result);
      }
    );

    this.fastify.get<{ Params: { version: string } }>(
      '/api/v1/rules/versions/:version',
      async (req, reply) => {
        const version = parseInt(req.params.version, 10);
        const snapshot = this.runtime.versionManager.getVersion(version);
        if (!snapshot) {
          reply.code(404).send({ error: `Version ${version} not found` });
          return;
        }
        reply.send({ snapshot });
      }
    );

    this.fastify.get<{ Params: { v1: string; v2: string } }>(
      '/api/v1/rules/versions/:v1/diff/:v2',
      async (req, reply) => {
        const v1 = parseInt(req.params.v1, 10);
        const v2 = parseInt(req.params.v2, 10);
        const diff = this.runtime.versionManager.diffVersions(v1, v2);
        if (diff === null) {
          reply.code(404).send({ error: `One or both versions not found: v1=${v1}, v2=${v2}` });
          return;
        }
        reply.send({
          v1,
          v2,
          diff
        });
      }
    );

    this.fastify.post<{ Params: { version: string } }>(
      '/api/v1/rules/versions/:version/rollback',
      async (req, reply) => {
        const targetVersion = parseInt(req.params.version, 10);
        const operator = extractOperator(req);

        const snapshot = this.runtime.versionManager.getVersion(targetVersion);
        if (!snapshot) {
          reply.code(404).send({ error: `Version ${targetVersion} not found` });
          return;
        }

        const result = await rollbackToVersion(this.runtime, targetVersion, operator);

        if (!result.success) {
          reply.code(404).send({ error: `Version ${targetVersion} not found` });
          return;
        }

        reply.send({
          ok: true,
          restored_rule_count: result.restoredRuleCount,
          added_count: result.addedCount,
          removed_count: result.removedCount,
          modified_count: result.modifiedCount,
          new_version: result.newVersion
        });
      }
    );

    this.fastify.get('/api/v1/silences', async (_req, reply) => {
      const silences = this.runtime.silenceManager.getAllSilences(true).map(s => ({
        id: s.id,
        starts_at: s.startsAt,
        ends_at: s.endsAt,
        cron_expression: s.cronExpression,
        matchers: s.matchers,
        created_by: s.createdBy,
        comment: s.comment,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
        is_active: this.runtime.silenceManager.isActive(s)
      }));
      reply.send({ silences });
    });

    this.fastify.get<{ Params: { id: string } }>('/api/v1/silences/:id', async (req, reply) => {
      const silence = this.runtime.silenceManager.getSilence(req.params.id);
      if (!silence) {
        reply.code(404).send({ error: 'Silence not found' });
        return;
      }
      reply.send({
        silence: {
          ...silence,
          is_active: this.runtime.silenceManager.isActive(silence)
        }
      });
    });

    this.fastify.post<{ Body: CreateSilenceRequest }>(
      '/api/v1/silences',
      async (req, reply) => {
        try {
          const request = req.body;
          if (!request.matchers) {
            reply.code(400).send({ error: 'matchers is required' });
            return;
          }
          const silence = this.runtime.silenceManager.createSilence(request);
          reply.code(201).send({ silence });
        } catch (e: any) {
          reply.code(400).send({ error: e.message || 'Invalid silence request' });
        }
      }
    );

    this.fastify.delete<{ Params: { id: string } }>(
      '/api/v1/silences/:id',
      async (req, reply) => {
        const ok = this.runtime.silenceManager.deleteSilence(req.params.id);
        if (!ok) {
          reply.code(404).send({ error: 'Silence not found' });
          return;
        }
        reply.send({ ok: true });
      }
    );

    this.fastify.put<{ Params: { id: string }; Body: ExtendSilenceRequest }>(
      '/api/v1/silences/:id/extend',
      async (req, reply) => {
        const duration = req.body.durationSeconds || req.body.duration_seconds;
        if (!duration || duration <= 0) {
          reply.code(400).send({ error: 'Valid durationSeconds is required' });
          return;
        }
        const silence = this.runtime.silenceManager.extendSilence(req.params.id, duration);
        if (!silence) {
          reply.code(404).send({ error: 'Silence not found' });
          return;
        }
        reply.send({ silence, extended_by_seconds: duration });
      }
    );

    this.fastify.get('/api/v1/templates', async (_req, reply) => {
      const templates = this.runtime.templateEngine.getAllTemplates().map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        is_builtin: t.isBuiltin,
        file_path: t.filePath,
        loaded_at: t.loadedAt
      }));
      reply.send({ templates });
    });

    this.fastify.get<{ Params: { id: string } }>('/api/v1/templates/:id', async (req, reply) => {
      const template = this.runtime.templateEngine.getTemplate(req.params.id);
      if (!template) {
        reply.code(404).send({ error: 'Template not found' });
        return;
      }
      reply.send({
        template: {
          id: template.id,
          name: template.name,
          description: template.description,
          content: template.content,
          is_builtin: template.isBuiltin,
          file_path: template.filePath,
          loaded_at: template.loadedAt
        }
      });
    });

    this.fastify.post<{ Body: TemplatePreviewRequest }>(
      '/api/v1/templates/preview',
      async (req, reply) => {
        const body = req.body as any;
        const templateId = body.templateId || body.template_id;
        const alert = body.alert;
        if (!templateId) {
          reply.code(400).send({ error: 'templateId or template_id is required' });
          return;
        }
        if (!this.runtime.templateEngine.hasTemplate(templateId)) {
          reply.code(404).send({ error: `Template ${templateId} not found` });
          return;
        }
        try {
          const rendered = this.runtime.templateEngine.preview(
            templateId,
            alert || {},
            this.runtime.config.timezone
          );
          reply.send({
            template_id: templateId,
            rendered,
            content_type: templateId === 'json' ? 'application/json' : 'text/plain'
          });
        } catch (e: any) {
          reply.code(500).send({ error: `Template render failed: ${e.message}` });
        }
      }
    );

    this.fastify.post<{ Body: { template_id: string; template_content: string; alert?: any } }>(
      '/api/v1/templates/render',
      async (req, reply) => {
        const { template_id, template_content, alert } = req.body;
        if (!template_content) {
          reply.code(400).send({ error: 'template_content is required' });
          return;
        }
        try {
          const tempId = '__adhoc__';
          const tplEngine = this.runtime.templateEngine as any;
          const compiled = tplEngine.handlebars.compile(template_content, { noEscape: true });
          const mockData = alert || {};
          const defaultLog = {
            timestamp: Date.now(),
            level: 'ERROR',
            source: 'test',
            message: 'Sample error message',
            fields: { component: 'api' },
            raw: ''
          };
          const ctx = {
            alert: {
              id: mockData.id || 'preview-alert-001',
              ruleName: mockData.ruleName || 'Preview Rule',
              ruleId: mockData.ruleId || 'preview-rule',
              severity: mockData.severity || 'warning',
              triggeredAt: new Date(mockData.triggeredAt || Date.now()).toISOString(),
              triggeredAtMs: mockData.triggeredAt || Date.now(),
              logs: mockData.logs || [defaultLog],
              logsCount: (mockData.logs || [defaultLog]).length,
              groupKey: mockData.groupKey,
              sequenceKey: mockData.sequenceKey,
              isRecovery: mockData.isRecovery,
              resolved: mockData.resolved
            },
            rule: {
              id: mockData.rule?.id || mockData.ruleId || 'preview-rule',
              name: mockData.rule?.name || mockData.ruleName || 'Preview Rule',
              description: mockData.rule?.description || 'Rule for preview',
              severity: mockData.rule?.severity || mockData.severity || 'warning',
              priority: mockData.rule?.priority || 50
            },
            logs: mockData.logs || [defaultLog],
            firstLog: (mockData.logs || [defaultLog])[0],
            lastLog: (mockData.logs || [defaultLog])[(mockData.logs || [defaultLog]).length - 1]
          };
          const rendered = compiled(ctx);
          reply.send({
            template_id,
            rendered
          });
        } catch (e: any) {
          reply.code(500).send({ error: `Template render failed: ${e.message}` });
        }
      }
    );

    this.fastify.get('/api/v1/stats', async (_req, reply) => {
      const stats = this.runtime.ruleEngine.getAllStats();
      reply.send({
        stats,
        total_processed: this.runtime.processedCount,
        total_alerts: this.runtime.alertCount,
        total_silenced: this.runtime.ruleEngine.getTotalSilencedCount()
      });
    });

    this.fastify.get<{ Params: { id: string } }>('/api/v1/stats/rules/:id', async (req, reply) => {
      const stats = this.runtime.ruleEngine.getRuleStats(req.params.id);
      if (!stats) {
        reply.code(404).send({ error: 'Rule not found' });
        return;
      }
      reply.send({ stats });
    });

    this.fastify.get('/api/v1/alerts/silenced', async (_req, reply) => {
      const silenced = this.runtime.ruleEngine.getSilencedAlerts(100);
      reply.send({ silenced_alerts: silenced });
    });

    this.fastify.get<{ Querystring: { limit?: string } }>('/api/v1/alerts', async (req, reply) => {
      const limit = parseInt(req.query.limit || '100', 10);
      const alerts = this.runtime.ruleEngine.getAllAlerts(limit);
      reply.send({ alerts });
    });

    this.fastify.get('/api/v1/alerts/active', async (_req, reply) => {
      const alerts = this.runtime.ruleEngine.getActiveAlerts();
      reply.send({ alerts });
    });

    this.fastify.post<{ Params: { sourceId?: string }; Body: any }>(
      '/api/v1/ingest',
      async (req, reply) => {
        const sourceId = (req.query as any)?.source_id || (req.params as any)?.sourceId || 'http_api';
        const results = this.runtime.inputManager.processHttpPayload(sourceId, req.body as string | object);

        for (const log of results) {
          this.runtime.processedCount++;
          this.runtime.ruleEngine.processLog(log);
        }
        this.runtime.silencedCount = this.runtime.ruleEngine.getTotalSilencedCount();

        reply.send({
          received: Array.isArray(req.body) ? req.body.length : 1,
          parsed: results.length
        });
      }
    );

    this.fastify.post<{ Body: { lines: string[]; max_suggestions?: number } }>(
      '/api/v1/infer',
      async (req, reply) => {
        const lines = req.body.lines || [];
        const maxSuggestions = req.body.max_suggestions || 5;

        if (lines.length < 20) {
          reply.code(400).send({
            error: 'At least 20 sample lines required for inference'
          });
          return;
        }

        const result = inferFormat(lines, maxSuggestions);
        reply.send(result);
      }
    );

    this.fastify.post<{ Body: { lines: string[]; parser_config: any; source?: string } }>(
      '/api/v1/test/parse',
      async (req, reply) => {
        const { lines, parser_config, source } = req.body;
        if (!lines || !parser_config) {
          reply.code(400).send({ error: 'lines and parser_config required' });
          return;
        }

        const parser = new LogParser(parser_config, this.runtime.config.timezone);
        const results: Array<{ line: string; success: boolean; log?: any; error?: string }> = [];

        for (const line of lines) {
          const result = parser.parseLine(line, source);
          if (result.log) {
            results.push({ line, success: true, log: result.log });
          } else {
            results.push({ line, success: false, error: result.error });
          }
        }

        const successCount = results.filter(r => r.success).length;
        reply.send({
          total: lines.length,
          parsed: successCount,
          parse_rate: lines.length > 0 ? successCount / lines.length : 0,
          results: results.slice(0, 100),
          errors: parser.getErrors().slice(0, 50)
        });
      }
    );

    this.fastify.post<{
      Body: {
        lines: string[];
        parser_config: any;
        rules: AlertRule[];
        source?: string;
      }
    }>('/api/v1/test/rules', async (req, reply) => {
      const { lines, parser_config, rules, source } = req.body;
      if (!lines || !parser_config || !rules) {
        reply.code(400).send({ error: 'lines, parser_config and rules required' });
        return;
      }

      const parser = new LogParser(parser_config, this.runtime.config.timezone);
      const testEngine = new (require('../engine').AlertRuleEngine)({ dryRun: true });
      const triggeredAlerts: TriggeredAlert[] = [];
      const ruleHits: Record<string, { rule: AlertRule; hit_count: number; silenced_count: number; matched_lines: string[]; timestamps: number[] }> = {};

      for (const rule of rules) {
        testEngine.addRule(rule);
        ruleHits[rule.id] = { rule, hit_count: 0, silenced_count: 0, matched_lines: [], timestamps: [] };
      }

      testEngine.onAlert((alert: TriggeredAlert) => {
        triggeredAlerts.push(alert);
        if (ruleHits[alert.ruleId]) {
          ruleHits[alert.ruleId].hit_count++;
          if (alert.logs.length > 0) {
            ruleHits[alert.ruleId].matched_lines.push(alert.logs[0].message.substring(0, 200));
            ruleHits[alert.ruleId].timestamps.push(alert.triggeredAt);
          }
        }
      });

      const parsedLogs: any[] = [];
      for (const line of lines) {
        const result = parser.parseLine(line, source);
        if (result.log) {
          parsedLogs.push(result.log);
          testEngine.processLog(result.log);
        }
      }

      reply.send({
        total_lines: lines.length,
        parsed_count: parsedLogs.length,
        alert_count: triggeredAlerts.length,
        silenced_count: testEngine.getTotalSilencedCount(),
        alerts: triggeredAlerts.slice(0, 100),
        silenced_alerts: testEngine.getSilencedAlerts(50),
        rule_hits: Object.values(ruleHits).map(rh => ({
          rule_id: rh.rule.id,
          rule_name: rh.rule.name,
          hit_count: rh.hit_count,
          silenced_count: testEngine.getRuleStats(rh.rule.id)?.silencedCount || 0,
          sample_matches: rh.matched_lines.slice(0, 10),
          trigger_timeline: rh.timestamps.slice(0, 100)
        }))
      });
    });

    this.fastify.get('/api/v1/sources', async (_req, reply) => {
      const sources = this.runtime.inputManager.getActiveSources().map(id => ({
        id,
        errors: this.runtime.inputManager.getParserErrors(id).length
      }));
      reply.send({ sources });
    });

    this.fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id/errors', async (req, reply) => {
      const errors = this.runtime.inputManager.getParserErrors(req.params.id);
      reply.send({ errors: errors.slice(0, 100) });
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.fastify.listen({ port: this.port, host: '0.0.0.0' });
      this.started = true;
      console.info(`[API] Server started on port ${this.port}`);
    } catch (e) {
      console.error('[API] Failed to start server:', e);
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.fastify.close();
    this.started = false;
    console.info('[API] Server stopped');
  }

  getFastifyInstance(): FastifyInstance {
    return this.fastify;
  }

  getPort(): number {
    return this.port;
  }

  isStarted(): boolean {
    return this.started;
  }
}
