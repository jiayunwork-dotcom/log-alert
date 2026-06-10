import { compileGrokPattern, compileRegexPattern, matchGrok, CompiledGrok } from '../grok/engine';
import { normalizeFields, parseTimestamp, normalizeLogLevel } from '../normalizer';
import { StructuredLog, ParserConfig, LogLevel } from '../types';
import { DEFAULT_GROK_PATTERNS } from '../grok/patterns';

export interface ParseResult {
  log: StructuredLog | null;
  error?: string;
}

interface CompiledSimpleRegex {
  regex: RegExp;
  fieldNames: string[];
}

const MONTH_NAME = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const IPV4_RE = '(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV6_RE = '(?:[0-9A-Fa-f:]{2,39})';
const HOSTNAME_RE = '(?:[0-9A-Za-z][0-9A-Za-z-]{0,62}(?:\\.[0-9A-Za-z][0-9A-Za-z-]{0,62})*)';
const IP_OR_HOST_RE = `(?:${IPV4_RE}|${HOSTNAME_RE})`;
const HTTPDATE_RE = `(?:(?:0[1-9]|[12][0-9]|3[01])/${MONTH_NAME}/(?:19|20|21)\\d\\d:(?:(?:2[0123]|[01]?[0-9]):(?:[0-5][0-9])(?::?(?:(?:[0-5][0-9]|60)(?:[.,][0-9]+)?))) (?:[+-]?(?:[0-9]+)))`;

const NGINX_RE: CompiledSimpleRegex = {
  regex: new RegExp(
    `^(${IP_OR_HOST_RE}) - ([a-zA-Z0-9._-]+|-) \\[(${HTTPDATE_RE})\\] "((?:\\w+)) ((?:/[^\\s?]+)(?:(?:\\?\\S*)?)) HTTP/((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)))" ((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+))) ((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)))(?: "((?:\\S+))" "((?:.*))"(?: ((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+))))?)?$`
  ),
  fieldNames: [
    'client_ip', 'remote_user', 'timestamp', 'method', 'path',
    'http_version', 'status', 'body_bytes_sent',
    'http_referer', 'http_user_agent', 'response_time'
  ]
};

const APACHE_RE: CompiledSimpleRegex = {
  regex: new RegExp(
    `^(${IP_OR_HOST_RE}) (?:([a-zA-Z0-9._-]+)|-) (?:([a-zA-Z0-9._-]+)|-) \\[(${HTTPDATE_RE})\\] "(?:((?:\\w+)) ((?:\\S+))(?: HTTP/((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+))))?|((?:.*?)))" ((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)|-)) ((?:[+-]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+))|-) "((?:\\S+))" "((?:.*))"$`
  ),
  fieldNames: [
    'clientip', 'ident', 'auth', 'timestamp',
    'verb', 'request', 'httpversion', 'rawrequest',
    'response', 'bytes', 'referrer', 'agent'
  ]
};

const ISO8601_RE = '(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:?\\d{2}(?::?\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)';
const SYSLOG5424_RE: CompiledSimpleRegex = {
  regex: new RegExp(
    `^<(\\d+)>(\\d+) +(?:(${ISO8601_RE})|-) +(?:(${IP_OR_HOST_RE})|-) +(?:(\\S+)|-) +(?:(\\S+)|-) +(?:(\\S+)|-) +(?:(\\[.+\\])|-|) +((?:.*))$`
  ),
  fieldNames: [
    'syslog5424_pri', 'syslog5424_ver', 'syslog5424_ts',
    'syslog5424_host', 'syslog5424_app', 'syslog5424_proc',
    'syslog5424_msgid', 'syslog5424_sd', 'syslog5424_msg'
  ]
};

export class LogParser {
  private config: ParserConfig;
  private compiledGrok?: CompiledGrok;
  private compiledRegex?: CompiledGrok;
  private compiledSimpleRegex?: CompiledSimpleRegex;
  private errorQueue: { line: string; error: string; timestamp: number }[] = [];
  private timezone: string;

  constructor(config: ParserConfig, timezone: string = 'UTC') {
    this.config = config;
    this.timezone = timezone;
    this.compilePatterns();
  }

  private compilePatterns(): void {
    try {
      switch (this.config.format) {
        case 'nginx':
          this.compiledSimpleRegex = NGINX_RE;
          break;
        case 'apache':
          this.compiledSimpleRegex = APACHE_RE;
          break;
        case 'syslog':
          this.compiledSimpleRegex = SYSLOG5424_RE;
          break;
        case 'grok':
          if (this.config.grokPattern) {
            this.compiledGrok = compileGrokPattern(
              this.config.grokPattern,
              this.config.customPatterns
            );
          }
          break;
        case 'regex':
          if (this.config.regexPattern) {
            this.compiledRegex = compileRegexPattern(this.config.regexPattern);
          }
          break;
        case 'json':
          break;
      }
    } catch (e) {
      console.error(`Failed to compile patterns: ${e}`);
    }
  }

  getConfig(): ParserConfig {
    return this.config;
  }

  updateConfig(config: ParserConfig): void {
    this.config = config;
    this.compilePatterns();
  }

  parseLine(rawLine: string, sourceOverride?: string): ParseResult {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return { log: null };
    }

    try {
      let fields: Record<string, any> = {};
      let rawTimestamp: any = null;
      let rawLevel: any = null;
      let message: string = trimmed;

      if (this.config.format === 'json') {
        const jsonResult = this.tryParseJson(trimmed);
        if (jsonResult) {
          fields = jsonResult.fields;
          rawTimestamp = jsonResult.timestamp;
          rawLevel = jsonResult.level;
          message = jsonResult.message || trimmed;
        } else {
          fields = { raw: trimmed };
        }
      } else if (this.compiledSimpleRegex) {
        const sm = trimmed.match(this.compiledSimpleRegex.regex);
        if (sm) {
          for (let i = 0; i < this.compiledSimpleRegex.fieldNames.length; i++) {
            if (sm[i + 1] !== undefined) {
              fields[this.compiledSimpleRegex.fieldNames[i]] = sm[i + 1];
            }
          }
          rawTimestamp = fields.timestamp || fields.syslog5424_ts || fields.time;
          rawLevel = fields.level || fields.severity;
          message = fields.message || fields.syslog5424_msg || trimmed;
        } else if (this.config.format === 'nginx' || this.config.format === 'apache' || this.config.format === 'syslog') {
          return this.handleParseError(trimmed, 'Pattern mismatch');
        } else {
          fields = { raw: trimmed };
        }
      } else if (this.compiledGrok) {
        const grokMatch = matchGrok(trimmed, this.compiledGrok);
        if (grokMatch) {
          fields = grokMatch;
          rawTimestamp = fields.timestamp || fields.syslog5424_ts || fields.time;
          rawLevel = fields.level || fields.severity;
          message = fields.message || fields.syslog5424_msg || trimmed;
        } else {
          fields = { raw: trimmed };
        }
      } else if (this.compiledRegex) {
        const regexMatch = matchGrok(trimmed, this.compiledRegex);
        if (regexMatch) {
          fields = regexMatch;
          rawTimestamp = fields.timestamp;
          rawLevel = fields.level;
          message = fields.message || trimmed;
        } else {
          return this.handleParseError(trimmed, 'Regex pattern mismatch');
        }
      }

      if (this.config.timeField && fields[this.config.timeField]) {
        rawTimestamp = fields[this.config.timeField];
      }
      if (this.config.levelField && fields[this.config.levelField]) {
        rawLevel = fields[this.config.levelField];
      }

      fields = normalizeFields(fields, this.timezone);

      const level = this.detectLogLevel(rawLevel, message, fields);
      const timestamp = parseTimestamp(rawTimestamp, this.timezone) ?? Date.now();
      const source = sourceOverride || this.config.source || 'unknown';

      fields.status = fields.status ?? fields.response;
      fields.client_ip = fields.client_ip ?? fields.clientip ?? fields.remote_addr ?? fields.ip;
      fields.response_time = fields.request_time ?? fields.response_time ?? fields.elapsed;
      fields.method = fields.method ?? fields.verb;

      const log: StructuredLog = {
        timestamp,
        level,
        source,
        message,
        fields,
        raw: rawLine
      };

      return { log };
    } catch (e) {
      return this.handleParseError(trimmed, String(e));
    }
  }

  private tryParseJson(line: string): { fields: Record<string, any>; timestamp?: any; level?: any; message?: string } | null {
    try {
      const obj = JSON.parse(line);
      const fields: Record<string, any> = {};

      const extract = (o: any, prefix: string = '') => {
        for (const [k, v] of Object.entries(o)) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            extract(v, key);
          } else {
            fields[key] = v;
          }
        }
      };
      extract(obj);

      const findField = (names: string[]): any => {
        for (const n of names) {
          for (const [k, v] of Object.entries(fields)) {
            if (k.toLowerCase() === n.toLowerCase()) return v;
          }
        }
        return undefined;
      };

      return {
        fields,
        timestamp: findField(['timestamp', 'ts', 'time', '@timestamp', 'datetime', 'date']),
        level: findField(['level', 'severity', 'loglevel', 'log_level', 'priority']),
        message: findField(['message', 'msg', 'log', 'text', 'content']) as string
      };
    } catch {
      return null;
    }
  }

  private detectLogLevel(rawLevel: any, message: string, fields: Record<string, any>): LogLevel {
    if (rawLevel !== undefined && rawLevel !== null && rawLevel !== '') {
      const level = normalizeLogLevel(rawLevel);
      if (level !== 'INFO' || String(rawLevel).toLowerCase() === 'info') return level;
    }

    if (fields.syslog5424_pri !== undefined) {
      const pri = parseInt(fields.syslog5424_pri, 10);
      if (!isNaN(pri)) {
        const severity = pri % 8;
        const syslogMap: LogLevel[] = ['FATAL', 'FATAL', 'FATAL', 'ERROR', 'WARN', 'INFO', 'INFO', 'DEBUG'];
        return syslogMap[severity] ?? 'INFO';
      }
    }

    const statusCode = fields.status ?? fields.response;
    if (statusCode !== undefined && statusCode !== null && statusCode !== '') {
      const code = typeof statusCode === 'number' ? statusCode : parseInt(String(statusCode), 10);
      if (!isNaN(code)) {
        if (code >= 500) return 'ERROR';
        if (code >= 400) return 'WARN';
      }
    }

    const msg = message.toUpperCase();
    if (msg.includes('FATAL') || msg.includes('CRITICAL')) return 'FATAL';
    if (msg.includes('ERROR') || msg.includes('EXCEPTION') || msg.includes('STACKTRACE')) return 'ERROR';
    if (msg.includes('WARN') || msg.includes('WARNING')) return 'WARN';
    if (msg.includes('DEBUG') || msg.includes('TRACE')) return 'DEBUG';

    return 'INFO';
  }

  private handleParseError(line: string, error: string): ParseResult {
    this.errorQueue.push({ line, error, timestamp: Date.now() });
    if (this.errorQueue.length > 10000) {
      this.errorQueue.shift();
    }
    return { log: null, error };
  }

  getErrors(): { line: string; error: string; timestamp: number }[] {
    return [...this.errorQueue];
  }

  clearErrors(): void {
    this.errorQueue = [];
  }
}
