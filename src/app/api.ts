import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCors from '@fastify/cors';
import { AppRuntime } from './runtime';
import { AlertRule, RuleStats, TriggeredAlert, Severity } from '../types';
import { inferFormat, InferredFormat } from '../inferrer';
import { LogParser } from '../parser';
import * as fs from 'fs';
import * as path from 'path';

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
        active_sources: this.runtime.inputManager.getActiveSources(),
        rule_count: this.runtime.ruleManager.getRules().length
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
        const ok = this.runtime.ruleManager.setRuleEnabled(req.params.id, req.body.enabled);
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
        const ok = this.runtime.ruleManager.suppressRule(req.params.id, req.body.duration_seconds || 300);
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
        this.runtime.ruleManager.resetRuleState(req.params.id);
        reply.send({ ok: true });
      }
    );

    this.fastify.get('/api/v1/stats', async (_req, reply) => {
      const stats = this.runtime.ruleEngine.getAllStats();
      reply.send({
        stats,
        total_processed: this.runtime.processedCount,
        total_alerts: this.runtime.alertCount
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

        if (lines.length < 10) {
          reply.code(400).send({
            error: 'At least 10 sample lines required for inference'
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
      const ruleHits: Record<string, { rule: AlertRule; hit_count: number; matched_lines: string[]; timestamps: number[] }> = {};

      for (const rule of rules) {
        testEngine.addRule(rule);
        ruleHits[rule.id] = { rule, hit_count: 0, matched_lines: [], timestamps: [] };
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
        alerts: triggeredAlerts.slice(0, 100),
        rule_hits: Object.values(ruleHits).map(rh => ({
          rule_id: rh.rule.id,
          rule_name: rh.rule.name,
          hit_count: rh.hit_count,
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
