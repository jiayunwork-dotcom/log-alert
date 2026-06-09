import { OutputChannel, WebhookOutput, ConsoleOutput, HttpOutput, TriggeredAlert, StructuredLog } from '../types';
import chalk from 'chalk';

export interface OutputDispatcherOptions {
  dryRun?: boolean;
  globalOutputs?: OutputChannel[];
}

export class OutputDispatcher {
  private channels: Map<string, OutputChannel> = new Map();
  private options: OutputDispatcherOptions;
  private httpClient: typeof fetch;

  constructor(options: OutputDispatcherOptions = {}) {
    this.options = options;
    this.httpClient = globalThis.fetch || (() => Promise.resolve(new Response()));
    (options.globalOutputs || []).forEach((ch, i) => {
      this.channels.set(`global_${i}`, ch);
    });
  }

  addChannel(id: string, channel: OutputChannel): void {
    this.channels.set(id, channel);
  }

  removeChannel(id: string): void {
    this.channels.delete(id);
  }

  async dispatch(alert: TriggeredAlert, ruleChannels?: OutputChannel[]): Promise<void> {
    const channels = ruleChannels && ruleChannels.length > 0
      ? ruleChannels
      : Array.from(this.channels.values());

    for (const channel of channels) {
      try {
        if (this.options.dryRun) {
          console.warn(`[DRY-RUN] Would dispatch to ${channel.type} channel`);
          continue;
        }
        await this.sendToChannel(alert, channel);
      } catch (e) {
        console.error(`Failed to dispatch to ${channel.type}:`, e);
      }
    }
  }

  private async sendToChannel(alert: TriggeredAlert, channel: OutputChannel): Promise<void> {
    switch (channel.type) {
      case 'webhook':
        await this.sendWebhook(alert, channel);
        break;
      case 'console':
        this.sendConsole(alert, channel);
        break;
      case 'http':
        await this.sendHttp(alert, channel);
        break;
    }
  }

  private buildPayload(alert: TriggeredAlert): Record<string, any> {
    const logSummary = alert.logs.slice(0, 10).map(log => ({
      timestamp: log.timestamp,
      level: log.level,
      source: log.source,
      message: log.message.substring(0, 500),
      fields: log.fields
    }));

    return {
      alert_id: alert.id,
      rule_id: alert.ruleId,
      rule_name: alert.ruleName,
      severity: alert.severity,
      original_severity: alert.originalSeverity,
      triggered_at: alert.triggeredAt,
      triggered_at_iso: new Date(alert.triggeredAt).toISOString(),
      is_recovery: alert.isRecovery || false,
      resolved: alert.resolved || false,
      resolved_at: alert.resolvedAt,
      logs_count: alert.logs.length,
      log_summary: logSummary,
      sequence_key: alert.sequenceKey,
      group_key: alert.groupKey,
      extra_fields: alert.extraFields
    };
  }

  private async sendWebhook(alert: TriggeredAlert, channel: WebhookOutput): Promise<void> {
    const payload = this.buildPayload(alert);

    const response = await this.httpClient(channel.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(channel.headers || {})
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  private sendConsole(alert: TriggeredAlert, channel: ConsoleOutput): void {
    const useColor = channel.color !== false;
    const output = process.stderr;

    const timestamp = new Date(alert.triggeredAt).toISOString();

    let severityColor: (s: string) => string;
    switch (alert.severity) {
      case 'critical':
        severityColor = useColor ? chalk.bgRed.white.bold : (s) => s;
        break;
      case 'warning':
        severityColor = useColor ? chalk.bgYellow.black.bold : (s) => s;
        break;
      case 'info':
      default:
        severityColor = useColor ? chalk.bgBlue.white.bold : (s) => s;
    }

    const prefix = alert.isRecovery
      ? (useColor ? chalk.green('[RECOVERY]') : '[RECOVERY]')
      : severityColor(`[${alert.severity.toUpperCase()}]`);

    const lines: string[] = [];
    lines.push(`${prefix} ${useColor ? chalk.cyan(timestamp) : timestamp} ${useColor ? chalk.bold(alert.ruleName) : alert.ruleName}`);
    lines.push(`  Rule ID: ${alert.ruleId}`);
    if (alert.groupKey) lines.push(`  Group: ${alert.groupKey}`);
    if (alert.sequenceKey) lines.push(`  Sequence Key: ${alert.sequenceKey}`);
    if (alert.severity !== alert.originalSeverity) {
      lines.push(`  Escalated from: ${alert.originalSeverity}`);
    }
    lines.push(`  Logs matched: ${alert.logs.length}`);

    if (alert.logs.length > 0) {
      lines.push('  --- Sample logs ---');
      for (let i = 0; i < Math.min(3, alert.logs.length); i++) {
        const log = alert.logs[i];
        const levelColor = this.getLevelColor(log.level, useColor);
        lines.push(`  [${levelColor(log.level)}] ${log.message.substring(0, 200)}`);
      }
    }

    output.write(lines.join('\n') + '\n');
  }

  private getLevelColor(level: string, useColor: boolean): (s: string) => string {
    if (!useColor) return (s) => s;
    switch (level) {
      case 'FATAL': return chalk.bgRed.white.bold;
      case 'ERROR': return chalk.red.bold;
      case 'WARN': return chalk.yellow.bold;
      case 'DEBUG': return chalk.gray.bold;
      case 'INFO':
      default: return chalk.white.bold;
    }
  }

  private async sendHttp(alert: TriggeredAlert, channel: HttpOutput): Promise<void> {
    const payload = this.buildPayload(alert);

    let body: string;
    if (channel.bodyTemplate) {
      body = this.renderTemplate(channel.bodyTemplate, alert, payload);
    } else {
      body = JSON.stringify(payload);
    }

    const headers: Record<string, string> = {
      'Content-Type': channel.bodyTemplate ? 'text/plain' : 'application/json',
      ...(channel.headers || {})
    };

    const response = await this.httpClient(channel.url, {
      method: channel.method,
      headers,
      body: channel.method === 'GET' ? undefined : body
    });

    if (!response.ok) {
      throw new Error(`HTTP push failed: ${response.status} ${response.statusText}`);
    }
  }

  private renderTemplate(template: string, alert: TriggeredAlert, payload: Record<string, any>): string {
    const ctx = {
      alert,
      payload,
      ...alert.extraFields,
      first_log: alert.logs[0] || null,
      last_log: alert.logs[alert.logs.length - 1] || null,
      now: new Date().toISOString()
    };

    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, expr) => {
      const parts = expr.split('.');
      let current: any = ctx;
      for (const part of parts) {
        if (current === null || current === undefined) return '';
        current = current[part];
      }
      return current !== null && current !== undefined ? String(current) : '';
    });
  }
}
