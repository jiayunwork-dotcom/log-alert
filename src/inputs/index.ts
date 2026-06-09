import { InputSource, FileInputSource, StdinInputSource, KafkaInputSource, HttpInputSource, ParserConfig, StructuredLog } from '../types';
import { LogParser } from '../parser';
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { Tail } from 'tail';
import { EventEmitter } from 'events';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';

export interface InputManagerOptions {
  timezone?: string;
}

export interface LogEvent {
  log: StructuredLog;
  sourceId: string;
}

type TailInstance = any;

export class InputManager extends EventEmitter {
  private parsers: Map<string, LogParser> = new Map();
  private tails: Map<string, TailInstance> = new Map();
  private kafkaConsumers: Map<string, Consumer> = new Map();
  private stdinActive: boolean = false;
  private options: InputManagerOptions;
  private httpEndpoints: Map<string, { port?: number }> = new Map();

  constructor(options: InputManagerOptions = {}) {
    super();
    this.options = options;
  }

  async startSources(sources: InputSource[]): Promise<void> {
    for (const source of sources) {
      try {
        await this.startSource(source);
      } catch (e) {
        console.error(`Failed to start input source ${source.id}:`, e);
      }
    }
  }

  private async startSource(source: InputSource): Promise<void> {
    const parser = new LogParser(source.parserConfig, this.options.timezone);
    this.parsers.set(source.id, parser);

    switch (source.type) {
      case 'file':
        await this.startFileSource(source as FileInputSource);
        break;
      case 'stdin':
        this.startStdinSource(source as StdinInputSource);
        break;
      case 'kafka':
        await this.startKafkaSource(source as KafkaInputSource);
        break;
      case 'http':
        this.registerHttpEndpoint(source as HttpInputSource);
        break;
    }
  }

  private async startFileSource(source: FileInputSource): Promise<void> {
    const resolvedPath = path.resolve(source.path);
    const files = this.resolveFiles(resolvedPath);

    for (const file of files) {
      this.startTailOnFile(file, source.id);
    }

    if (source.path.includes('*') || source.path.includes('?')) {
      this.watchForNewFiles(resolvedPath, source.id);
    }
  }

  private resolveFiles(pattern: string): string[] {
    try {
      if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
        return [pattern];
      }
      return globSync(pattern);
    } catch {
      return [];
    }
  }

  private startTailOnFile(filePath: string, sourceId: string): void {
    const key = `${sourceId}:${filePath}`;
    if (this.tails.has(key)) return;

    try {
      const parser = this.parsers.get(sourceId);
      if (!parser) return;

      if (!fs.existsSync(filePath)) {
        console.warn(`[Input] File not found, will wait: ${filePath}`);
        return;
      }

      const tail = new Tail(filePath, {
        follow: true,
        fromBeginning: false,
        useWatchFile: true,
        fsWatchOptions: { interval: 100 }
      });

      tail.on('line', (line: string) => {
        this.processLine(line, sourceId, parser, filePath);
      });

      tail.on('error', (error: any) => {
        console.error(`[Input] Tail error on ${filePath}:`, error.message);
      });

      (tail as any).on('rename', () => {
        console.info(`[Input] File rotated: ${filePath}, restarting tail...`);
        setTimeout(() => {
          try { tail.unwatch(); } catch {}
          this.tails.delete(key);
          if (fs.existsSync(filePath)) {
            this.startTailOnFile(filePath, sourceId);
          }
        }, 100);
      });

      this.tails.set(key, tail);
      console.info(`[Input] Tailing file: ${filePath}`);
    } catch (e) {
      console.error(`[Input] Failed to tail ${filePath}:`, e);
    }
  }

  private watchForNewFiles(pattern: string, sourceId: string): void {
    const dir = path.dirname(pattern.split('*')[0]) || '.';
    try {
      fs.watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        const fullPath = path.join(dir, filename);
        const files = this.resolveFiles(pattern);
        if (files.includes(fullPath)) {
          this.startTailOnFile(fullPath, sourceId);
        }
      });
    } catch (e) {
      console.warn(`[Input] Could not watch directory ${dir}:`, e);
    }
  }

  private startStdinSource(source: StdinInputSource): void {
    if (this.stdinActive) return;
    this.stdinActive = true;

    const parser = this.parsers.get(source.id);
    if (!parser) return;

    process.stdin.setEncoding('utf8');
    let buffer = '';

    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line) {
          this.processLine(line, source.id, parser, 'stdin');
        }
      }
    });

    process.stdin.on('end', () => {
      if (buffer.trim()) {
        this.processLine(buffer.trim(), source.id, parser, 'stdin');
      }
    });

    console.info('[Input] Reading from stdin');
  }

  private async startKafkaSource(source: KafkaInputSource): Promise<void> {
    try {
      const kafka = new Kafka({
        brokers: source.brokers,
        clientId: 'log-alert-consumer'
      });

      const consumer = kafka.consumer({ groupId: source.groupId });
      await consumer.subscribe({ topic: source.topic, fromBeginning: false });

      const parser = this.parsers.get(source.id);
      if (!parser) return;

      await consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          const message = payload.message.value?.toString('utf8');
          if (message) {
            this.processLine(message, source.id, parser, `kafka:${source.topic}`);
          }
        }
      });

      this.kafkaConsumers.set(source.id, consumer);
      console.info(`[Input] Kafka consumer started: ${source.topic} (group: ${source.groupId})`);
    } catch (e) {
      console.error(`[Input] Kafka error for ${source.id}:`, e);
      throw e;
    }
  }

  private registerHttpEndpoint(source: HttpInputSource): void {
    this.httpEndpoints.set(source.id, { port: source.port });
    console.info(`[Input] HTTP endpoint registered: ${source.id}`);
  }

  getHttpSource(sourceId: string): HttpInputSource | null {
    const endpoint = this.httpEndpoints.get(sourceId);
    if (!endpoint) return null;
    const parserConfig = this.parsers.get(sourceId)
      ? { format: 'json' as const }
      : { format: 'json' as const };
    return {
      type: 'http',
      id: sourceId,
      port: endpoint.port,
      parserConfig
    };
  }

  processHttpPayload(sourceId: string, data: string | object): StructuredLog[] {
    const parser = this.parsers.get(sourceId);
    if (!parser) return [];

    const results: StructuredLog[] = [];
    const lines: string[] = [];

    if (typeof data === 'string') {
      lines.push(...data.split(/\r?\n/).filter(l => l.trim()));
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          lines.push(item);
        } else {
          lines.push(JSON.stringify(item));
        }
      }
    } else if (data && typeof data === 'object') {
      lines.push(JSON.stringify(data));
    }

    for (const line of lines) {
      this.processLine(line, sourceId, parser, 'http', results);
    }

    return results;
  }

  private processLine(
    line: string,
    sourceId: string,
    parser: LogParser,
    fallbackSource: string,
    externalResults?: StructuredLog[]
  ): void {
    const result = parser.parseLine(line, fallbackSource);
    if (result.log) {
      if (externalResults) {
        externalResults.push(result.log);
      } else {
        this.emit('log', { log: result.log, sourceId });
      }
    }
  }

  updateParserConfig(sourceId: string, config: ParserConfig): boolean {
    const parser = this.parsers.get(sourceId);
    if (!parser) return false;
    parser.updateConfig(config);
    return true;
  }

  getParserErrors(sourceId: string): { line: string; error: string; timestamp: number }[] {
    const parser = this.parsers.get(sourceId);
    return parser ? parser.getErrors() : [];
  }

  clearParserErrors(sourceId: string): void {
    const parser = this.parsers.get(sourceId);
    if (parser) parser.clearErrors();
  }

  getActiveSources(): string[] {
    const sources: string[] = [];
    sources.push(...this.parsers.keys());
    return sources;
  }

  async stop(): Promise<void> {
    for (const [key, tail] of this.tails.entries()) {
      try {
        tail.unwatch();
      } catch {}
    }
    this.tails.clear();

    for (const [id, consumer] of this.kafkaConsumers.entries()) {
      try {
        await consumer.disconnect();
      } catch {}
    }
    this.kafkaConsumers.clear();

    this.stdinActive = false;
    this.parsers.clear();
    this.httpEndpoints.clear();
  }
}
