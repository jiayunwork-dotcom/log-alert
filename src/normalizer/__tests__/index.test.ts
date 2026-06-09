import { parseTimestamp, normalizeIP, normalizeLogLevel, inferNumber, normalizeFields } from '../index';

describe('Normalizer', () => {
  describe('parseTimestamp', () => {
    it('should parse ISO8601 format', () => {
      const ts = parseTimestamp('2024-06-10T13:45:30.000Z');
      expect(ts).toBe(1718027130000);
    });

    it('should parse Unix timestamp seconds', () => {
      const ts = parseTimestamp('1718027130');
      expect(ts).toBe(1718027130000);
    });

    it('should parse Unix timestamp milliseconds', () => {
      const ts = parseTimestamp('1718027130000');
      expect(ts).toBe(1718027130000);
    });

    it('should parse numeric unix timestamp', () => {
      const ts = parseTimestamp(1718027130);
      expect(ts).toBe(1718027130000);
    });

    it('should parse HTTP date format', () => {
      const ts = parseTimestamp('10/Jun/2024:13:45:30 +0000');
      expect(typeof ts).toBe('number');
      expect(ts).toBeGreaterThan(0);
    });

    it('should return current time for null/undefined', () => {
      const before = Date.now();
      const ts = parseTimestamp(null);
      const after = Date.now();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('normalizeIP', () => {
    it('should normalize IPv4', () => {
      expect(normalizeIP('192.168.001.001')).toBe('192.168.1.1');
    });

    it('should strip port from IPv4', () => {
      expect(normalizeIP('192.168.1.1:8080')).toBe('192.168.1.1');
    });

    it('should normalize IPv6', () => {
      const result = normalizeIP('::1');
      expect(result).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    });

    it('should return null for empty input', () => {
      expect(normalizeIP(null)).toBeNull();
      expect(normalizeIP('')).toBeNull();
    });
  });

  describe('normalizeLogLevel', () => {
    it('should map common aliases', () => {
      expect(normalizeLogLevel('error')).toBe('ERROR');
      expect(normalizeLogLevel('ERROR')).toBe('ERROR');
      expect(normalizeLogLevel('err')).toBe('ERROR');
      expect(normalizeLogLevel('warning')).toBe('WARN');
      expect(normalizeLogLevel('WARN')).toBe('WARN');
      expect(normalizeLogLevel('debug')).toBe('DEBUG');
      expect(normalizeLogLevel('info')).toBe('INFO');
      expect(normalizeLogLevel('fatal')).toBe('FATAL');
      expect(normalizeLogLevel('critical')).toBe('FATAL');
    });

    it('should default to INFO', () => {
      expect(normalizeLogLevel(null)).toBe('INFO');
      expect(normalizeLogLevel('unknown')).toBe('INFO');
    });
  });

  describe('inferNumber', () => {
    it('should parse integers', () => {
      expect(inferNumber('42')).toBe(42);
      expect(inferNumber('+100')).toBe(100);
      expect(inferNumber('-50')).toBe(-50);
    });

    it('should parse floats', () => {
      expect(inferNumber('3.14')).toBeCloseTo(3.14);
      expect(inferNumber('-0.5')).toBeCloseTo(-0.5);
    });

    it('should parse scientific notation', () => {
      expect(inferNumber('1.5e10')).toBe(1.5e10);
    });

    it('should leave non-numeric strings unchanged', () => {
      expect(inferNumber('hello')).toBe('hello');
      expect(inferNumber('')).toBe('');
    });
  });

  describe('normalizeFields', () => {
    it('should normalize IP fields', () => {
      const result = normalizeFields({ client_ip: '192.168.1.1:8080' });
      expect(result.client_ip).toBe('192.168.1.1');
    });

    it('should infer numeric fields', () => {
      const result = normalizeFields({ response_time: '0.235', status: '200' });
      expect(result.response_time).toBeCloseTo(0.235);
      expect(result.status).toBe(200);
    });

    it('should normalize log level fields', () => {
      const result = normalizeFields({ log_level: 'warning' });
      expect(result.log_level).toBe('WARN');
    });
  });
});
