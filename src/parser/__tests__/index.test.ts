import { LogParser } from '../index';
import { ParserConfig } from '../../types';

describe('LogParser', () => {
  describe('NGINX format', () => {
    const config: ParserConfig = { format: 'nginx', source: 'nginx' };
    const parser = new LogParser(config);

    it('should parse standard NGINX access log', () => {
      const line = '192.168.1.100 - - [10/Jun/2024:14:30:00 +0000] "GET /api/v1/users HTTP/1.1" 200 1234 "-" "Mozilla/5.0" 0.123';
      const result = parser.parseLine(line);
      expect(result.log).not.toBeNull();
      expect(result.log?.level).toBe('INFO');
      expect(result.log?.source).toBe('nginx');
      expect(result.log?.fields.client_ip).toBe('192.168.1.100');
      expect(result.log?.fields.method).toBe('GET');
      expect(result.log?.fields.path).toBe('/api/v1/users');
      expect(result.log?.fields.status).toBe(200);
      expect(result.log?.fields.response_time).toBeCloseTo(0.123);
    });

    it('should detect 5xx status as ERROR level', () => {
      const line = '192.168.1.1 - - [10/Jun/2024:14:30:00 +0000] "GET /api/broken HTTP/1.1" 500 500';
      const result = parser.parseLine(line);
      expect(result.log?.level).toBe('ERROR');
    });

    it('should detect 4xx status as WARN level', () => {
      const line = '192.168.1.1 - - [10/Jun/2024:14:30:00 +0000] "GET /missing HTTP/1.1" 404 100';
      const result = parser.parseLine(line);
      expect(result.log?.level).toBe('WARN');
    });
  });

  describe('JSON format', () => {
    const config: ParserConfig = { format: 'json', source: 'app' };
    const parser = new LogParser(config);

    it('should parse flat JSON log', () => {
      const line = JSON.stringify({
        timestamp: '2024-06-10T14:30:00.000Z',
        level: 'ERROR',
        message: 'Database connection failed',
        service: 'payment-service'
      });
      const result = parser.parseLine(line);
      expect(result.log?.level).toBe('ERROR');
      expect(result.log?.message).toBe('Database connection failed');
      expect(result.log?.fields['service']).toBe('payment-service');
    });

    it('should parse nested JSON log', () => {
      const line = JSON.stringify({
        '@timestamp': '2024-06-10T14:30:00.000Z',
        severity: 'warn',
        msg: 'High memory usage',
        meta: { cpu: 85, memory: 4096 }
      });
      const result = parser.parseLine(line);
      expect(result.log?.level).toBe('WARN');
      expect(result.log?.message).toBe('High memory usage');
      expect(result.log?.fields['meta.cpu']).toBe(85);
    });
  });

  describe('Syslog format', () => {
    const config: ParserConfig = { format: 'syslog', source: 'syslog' };
    const parser = new LogParser(config);

    it('should parse RFC5424 syslog', () => {
      const line = '<36>1 2024-06-10T14:30:00.000Z myhost.example.com sshd 12345 - - Failed password for root from 192.168.1.100';
      const result = parser.parseLine(line);
      expect(result.log).not.toBeNull();
      expect(result.log?.level).toBe('WARN');
      expect(result.log?.fields['syslog5424_host']).toBe('myhost.example.com');
      expect(result.log?.fields['syslog5424_app']).toBe('sshd');
    });
  });

  describe('Custom Grok pattern', () => {
    const config: ParserConfig = {
      format: 'grok',
      grokPattern: '%{TIMESTAMP_ISO8601:timestamp} %{WORD:level} %{GREEDYDATA:message}',
      source: 'custom'
    };
    const parser = new LogParser(config);

    it('should parse custom pattern', () => {
      const line = '2024-06-10T14:30:00Z INFO Server started successfully';
      const result = parser.parseLine(line);
      expect(result.log?.level).toBe('INFO');
      expect(result.log?.message).toBe('Server started successfully');
    });
  });

  describe('Error handling', () => {
    it('should handle Grok mismatch gracefully', () => {
      const config: ParserConfig = { format: 'nginx', source: 'nginx' };
      const parser = new LogParser(config);
      const result = parser.parseLine('invalid log line');
      expect(result.log).toBeNull();
      expect(result.error).toBeDefined();
      expect(parser.getErrors().length).toBe(1);
    });

    it('should skip empty lines', () => {
      const config: ParserConfig = { format: 'json', source: 'app' };
      const parser = new LogParser(config);
      const result = parser.parseLine('   ');
      expect(result.log).toBeNull();
      expect(result.error).toBeUndefined();
    });
  });
});
