export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export type Severity = 'critical' | 'warning' | 'info';

export interface StructuredLog {
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  fields: Record<string, any>;
  raw: string;
}

export type ConditionType = 'simple' | 'composite' | 'aggregate' | 'sequence';

export type ComparisonOperator =
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'not_matches'
  | 'in'
  | 'not_in';

export interface SimpleCondition {
  type: 'simple';
  field: string;
  operator: ComparisonOperator;
  value: any;
}

export type CompositeOperator = 'AND' | 'OR' | 'NOT';

export interface CompositeCondition {
  type: 'composite';
  operator: CompositeOperator;
  conditions: Condition[];
}

export interface AggregateCondition {
  type: 'aggregate';
  windowSeconds: number;
  slideSeconds: number;
  threshold: number;
  groupBy?: string[];
  baseCondition: Condition;
  aggregation: 'count' | 'sum' | 'avg';
  aggregateField?: string;
}

export interface SequenceEvent {
  eventId: string;
  condition: Condition;
  timeoutSeconds: number;
}

export interface SequenceCondition {
  type: 'sequence';
  keyField: string;
  events: SequenceEvent[];
  maxTotalSeconds: number;
}

export type Condition =
  | SimpleCondition
  | CompositeCondition
  | AggregateCondition
  | SequenceCondition;

export type OutputChannelType = 'webhook' | 'console' | 'http';

export interface WebhookOutput {
  type: 'webhook';
  url: string;
  headers?: Record<string, string>;
}

export interface ConsoleOutput {
  type: 'console';
  color?: boolean;
}

export interface HttpOutput {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

export type OutputChannel = WebhookOutput | ConsoleOutput | HttpOutput;

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  severity: Severity;
  priority: number;
  enabled: boolean;
  condition: Condition;
  actions: OutputChannel[];
  cooldownSeconds?: number;
  dependsOn?: string[];
  escalation?: {
    toSeverity: Severity;
    afterSeconds: number;
  };
  recoveryNotification?: boolean;
  dedup?: {
    windowSeconds: number;
    hashPrefixLength?: number;
  };
  topN?: {
    windowSeconds: number;
    n: number;
    field?: string;
  };
}

export interface TriggeredAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  originalSeverity: Severity;
  triggeredAt: number;
  logs: StructuredLog[];
  extraFields: Record<string, any>;
  resolved?: boolean;
  resolvedAt?: number;
  isRecovery?: boolean;
  sequenceKey?: string;
  groupKey?: string;
}

export interface RuleStats {
  ruleId: string;
  triggerCount: number;
  lastTriggeredAt: number | null;
  firstTriggeredAt: number | null;
  averageIntervalMs: number | null;
  intervals: number[];
}

export type InputSourceType = 'file' | 'stdin' | 'kafka' | 'http';

export interface FileInputSource {
  type: 'file';
  id: string;
  path: string;
  pattern?: string;
  parserConfig: ParserConfig;
}

export interface StdinInputSource {
  type: 'stdin';
  id: string;
  parserConfig: ParserConfig;
}

export interface KafkaInputSource {
  type: 'kafka';
  id: string;
  brokers: string[];
  topic: string;
  groupId: string;
  parserConfig: ParserConfig;
}

export interface HttpInputSource {
  type: 'http';
  id: string;
  port?: number;
  parserConfig: ParserConfig;
}

export type InputSource =
  | FileInputSource
  | StdinInputSource
  | KafkaInputSource
  | HttpInputSource;

export interface ParserConfig {
  format?: 'nginx' | 'apache' | 'syslog' | 'json' | 'grok' | 'regex';
  grokPattern?: string;
  regexPattern?: string;
  timeField?: string;
  levelField?: string;
  source?: string;
  customPatterns?: Record<string, string>;
}

export interface AppConfig {
  inputSources: InputSource[];
  ruleFiles: string[];
  globalOutputs?: OutputChannel[];
  httpApiPort?: number;
  dryRun?: boolean;
  timezone?: string;
}
