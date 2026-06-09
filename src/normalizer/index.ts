import moment from 'moment-timezone';
import { LogLevel } from '../types';

const TIME_FORMATS: string[] = [
  'YYYY-MM-DDTHH:mm:ss.SSSZ',
  'YYYY-MM-DDTHH:mm:ss.SSS',
  'YYYY-MM-DDTHH:mm:ssZ',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DD HH:mm:ss.SSS',
  'YYYY-MM-DD HH:mm:ss',
  'DD/MMM/YYYY:HH:mm:ss ZZ',
  'DD/MMM/YYYY:HH:mm:ss',
  'MMM DD HH:mm:ss',
  'MMM  D HH:mm:ss',
  'ddd, DD MMM YYYY HH:mm:ss ZZ',
  'ddd MMM DD HH:mm:ss YYYY',
  'MM/DD/YYYY HH:mm:ss',
  'DD-MM-YYYY HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'YYYYMMDDTHHmmssZ',
  'YYYYMMDDTHHmmss',
  'YYYY.MM.DD HH:mm:ss',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'YYYY-MM-DD'
];

const MONTH_MAP: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

export function parseTimestamp(value: any, timezone: string = 'UTC'): number | null {
  if (value === null || value === undefined) return Date.now();

  if (typeof value === 'number') {
    if (value > 1e12) return value;
    return value * 1000;
  }

  const str = String(value).trim();

  if (/^\d{10}$/.test(str)) {
    return parseInt(str, 10) * 1000;
  }
  if (/^\d{13}$/.test(str)) {
    return parseInt(str, 10);
  }
  if (/^\d{10}\.\d+$/.test(str)) {
    return Math.floor(parseFloat(str) * 1000);
  }

  for (const fmt of TIME_FORMATS) {
    const m = moment.tz(str, fmt, true, timezone);
    if (m.isValid()) {
      return m.valueOf();
    }
  }

  const m = moment.tz(str, timezone);
  if (m.isValid()) {
    return m.valueOf();
  }

  const fallback = parseCustomSyslog(str);
  if (fallback !== null) return fallback;

  return Date.now();
}

function parseCustomSyslog(str: string): number | null {
  const syslogRe = /^(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/;
  const m = str.match(syslogRe);
  if (m) {
    const month = MONTH_MAP[m[1]];
    if (month !== undefined) {
      const now = new Date();
      const year = now.getFullYear();
      const d = new Date(Date.UTC(
        year, month, parseInt(m[2]),
        parseInt(m[3]), parseInt(m[4]), parseInt(m[5]),
        m[6] ? parseInt(m[6].substring(0, 3).padEnd(3, '0')) : 0
      ));
      if (d.getTime() > now.getTime() + 86400000) {
        d.setFullYear(year - 1);
      }
      return d.getTime();
    }
  }
  return null;
}

export function normalizeIP(value: any): string | null {
  if (!value) return null;
  const str = String(value).trim();

  const ipv4WithPort = str.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
  const ipStr = ipv4WithPort ? ipv4WithPort[1] : str;

  const ipv4 = ipStr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1, 5).map(n => parseInt(n, 10));
    if (parts.every(n => n >= 0 && n <= 255)) {
      return parts.join('.');
    }
  }

  if (ipStr.includes(':')) {
    try {
      const noBrackets = ipStr.replace(/^\[|\]$/g, '');
      const parts = noBrackets.split('::');
      let groups: string[] = [];
      if (parts.length === 2) {
        const left = parts[0].split(':').filter(x => x);
        const right = parts[1].split(':').filter(x => x);
        const missing = 8 - left.length - right.length;
        groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
      } else {
        groups = noBrackets.split(':').filter(x => x);
      }
      groups = groups.slice(0, 8).map(g => g.padStart(4, '0'));
      while (groups.length < 8) groups.push('0000');
      return groups.join(':');
    } catch {
      return ipStr;
    }
  }

  return ipStr;
}

const LEVEL_ALIASES: Record<string, LogLevel> = {
  'DEBUG': 'DEBUG', 'debug': 'DEBUG', 'DBG': 'DEBUG', 'dbg': 'DEBUG', 'D': 'DEBUG', 'd': 'DEBUG',
  'TRACE': 'DEBUG', 'trace': 'DEBUG',
  'INFO': 'INFO', 'info': 'INFO', 'INF': 'INFO', 'inf': 'INFO', 'I': 'INFO', 'i': 'INFO',
  'LOG': 'INFO', 'log': 'INFO', 'NOTICE': 'INFO', 'notice': 'INFO',
  'WARN': 'WARN', 'warn': 'WARN', 'WARNING': 'WARN', 'warning': 'WARN',
  'WRN': 'WARN', 'wrn': 'WARN', 'W': 'WARN', 'w': 'WARN',
  'ERROR': 'ERROR', 'error': 'ERROR', 'ERR': 'ERROR', 'err': 'ERROR',
  'E': 'ERROR', 'e': 'ERROR', 'SEVERE': 'ERROR', 'severe': 'ERROR',
  'FATAL': 'FATAL', 'fatal': 'FATAL', 'CRIT': 'FATAL', 'crit': 'FATAL',
  'CRITICAL': 'FATAL', 'critical': 'FATAL', 'F': 'FATAL', 'f': 'FATAL',
  'ALERT': 'FATAL', 'alert': 'FATAL', 'EMERG': 'FATAL', 'emerg': 'FATAL'
};

export function normalizeLogLevel(value: any): LogLevel {
  if (!value) return 'INFO';
  const str = String(value).trim().toUpperCase();

  const alias = LEVEL_ALIASES[str] || LEVEL_ALIASES[str.toLowerCase()];
  if (alias) return alias;

  if (str.includes('ERROR') || str.includes('ERR')) return 'ERROR';
  if (str.includes('WARN')) return 'WARN';
  if (str.includes('FATAL') || str.includes('CRIT')) return 'FATAL';
  if (str.includes('DEBUG') || str.includes('TRACE')) return 'DEBUG';
  return 'INFO';
}

export function inferNumber(value: any): any {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed === '') return value;

  if (/^[+-]?\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  if (/^[+-]?\d+\.\d+$/.test(trimmed)) {
    const f = parseFloat(trimmed);
    if (!isNaN(f)) return f;
  }

  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(trimmed)) {
    const f = parseFloat(trimmed);
    if (!isNaN(f)) return f;
  }

  return value;
}

const TIMESTAMP_KEY_NAMES = new Set([
  'timestamp', 'ts', 'time', 'datetime', 'date',
  '@timestamp', '@time', 'event_time', 'log_time',
  'created_at', 'updated_at', 'occurred_at'
]);

const LEVEL_KEY_PATTERN = /(^|_)(level|severity|priority)($|_)/i;
const TIME_KEY_PATTERN = /(^|_)(timestamp|ts|datetime|date|created_at|updated_at|occurred_at|event_time|log_time)($|_)/i;

export function normalizeFields(fields: Record<string, any>, timezone: string = 'UTC'): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      result[key] = value;
      continue;
    }

    let normalized = value;
    const keyLower = key.toLowerCase();

    if ((keyLower.includes('ip') && !keyLower.includes('rip')) || key === 'clientip' || key === 'remote_addr') {
      const ip = normalizeIP(value);
      if (ip !== null) normalized = ip;
    } else if (
      TIMESTAMP_KEY_NAMES.has(keyLower) ||
      TIME_KEY_PATTERN.test(key)
    ) {
      const ts = parseTimestamp(value, timezone);
      if (ts !== null) normalized = ts;
    } else if (LEVEL_KEY_PATTERN.test(key)) {
      normalized = normalizeLogLevel(value);
    } else {
      normalized = inferNumber(value);
    }

    result[key] = normalized;
  }

  return result;
}
