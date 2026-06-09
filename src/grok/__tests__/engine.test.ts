import { compileGrokPattern, compileRegexPattern, matchGrok, testGrokMatchRate } from '../engine';
import { DEFAULT_GROK_PATTERNS } from '../patterns';

describe('Grok Engine', () => {
  describe('compileGrokPattern', () => {
    it('should compile simple IP pattern', () => {
      const compiled = compileGrokPattern('%{IP:client_ip}');
      expect(compiled.fieldNames).toEqual(['client_ip']);
      expect(compiled.regex).toBeInstanceOf(RegExp);
    });

    it('should compile NGINX access log pattern', () => {
      const compiled = compileGrokPattern(DEFAULT_GROK_PATTERNS.NGINXACCESS);
      expect(compiled.fieldNames.length).toBeGreaterThan(3);
      expect(compiled.fieldNames).toContain('client_ip');
      expect(compiled.fieldNames).toContain('timestamp');
      expect(compiled.fieldNames).toContain('status');
    });

    it('should handle nested patterns correctly', () => {
      const compiled = compileGrokPattern('%{IPORHOST:host}');
      expect(compiled.fieldNames).toEqual(['host']);
    });
  });

  describe('matchGrok', () => {
    it('should match NGINX access log line', () => {
      const compiled = compileGrokPattern(DEFAULT_GROK_PATTERNS.NGINXACCESS);
      const line = '192.168.1.1 - - [10/Jun/2024:13:45:30 +0000] "GET /api/users HTTP/1.1" 200 1234';
      const match = matchGrok(line, compiled);
      expect(match).not.toBeNull();
      expect(match?.client_ip).toBe('192.168.1.1');
      expect(match?.method).toBe('GET');
      expect(match?.path).toBe('/api/users');
      expect(match?.status).toBe('200');
    });

    it('should match Apache Combined Log', () => {
      const compiled = compileGrokPattern(DEFAULT_GROK_PATTERNS.COMBINEDAPACHELOG);
      const line = '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08"';
      const match = matchGrok(line, compiled);
      expect(match).not.toBeNull();
      expect(match?.clientip).toBe('127.0.0.1');
      expect(match?.auth).toBe('frank');
      expect(match?.response).toBe('200');
    });

    it('should return null for non-matching line', () => {
      const compiled = compileGrokPattern('%{IP:host}');
      const match = matchGrok('not an ip', compiled);
      expect(match).toBeNull();
    });
  });

  describe('compileRegexPattern', () => {
    it('should compile named capture group regex', () => {
      const compiled = compileRegexPattern('(?P<status>\\d{3}) (?P<message>.*)');
      expect(compiled.fieldNames).toEqual(['status', 'message']);
      const match = matchGrok('404 Not Found', compiled);
      expect(match?.status).toBe('404');
      expect(match?.message).toBe('Not Found');
    });
  });

  describe('testGrokMatchRate', () => {
    it('should calculate correct match rate', () => {
      const compiled = compileGrokPattern('%{IP:host}');
      const lines = [
        '192.168.1.1',
        '10.0.0.1',
        'invalid',
        '172.16.0.1'
      ];
      const result = testGrokMatchRate(compiled, lines);
      expect(result.total).toBe(4);
      expect(result.matched).toBe(3);
      expect(result.rate).toBeCloseTo(0.75);
    });
  });
});
