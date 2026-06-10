import { AppConfig, InputSource, OutputChannel, ParserConfig, AlertRule } from '../types';
import { InputManager } from '../inputs';
import { AlertRuleEngine } from '../engine';
import { OutputDispatcher } from '../outputs';
import { RuleManager } from '../rules';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface AppRuntime {
  inputManager: InputManager;
  ruleEngine: AlertRuleEngine;
  outputDispatcher: OutputDispatcher;
  ruleManager: RuleManager;
  config: AppConfig;
  processedCount: number;
  alertCount: number;
  startTime: number;
}

export function createAppRuntime(config: AppConfig): AppRuntime {
  const ruleEngine = new AlertRuleEngine({
    dryRun: config.dryRun
  });

  const outputDispatcher = new OutputDispatcher({
    dryRun: config.dryRun,
    globalOutputs: config.globalOutputs
  });

  const ruleManager = new RuleManager(ruleEngine, outputDispatcher, {
    dryRun: config.dryRun
  });

  const inputManager = new InputManager({
    timezone: config.timezone
  });

  const runtime: AppRuntime = {
    inputManager,
    ruleEngine,
    outputDispatcher,
    ruleManager,
    config,
    processedCount: 0,
    alertCount: 0,
    startTime: Date.now()
  };

  ruleEngine.onAlert(async (alert) => {
    runtime.alertCount++;
    const rule = ruleManager.getRule(alert.ruleId);
    const channels = rule?.actions || config.globalOutputs || [];
    try {
      await outputDispatcher.dispatch(alert, channels);
    } catch (e) {
      console.error('Error dispatching alert:', e);
    }
  });

  inputManager.on('log', (event) => {
    runtime.processedCount++;
    ruleEngine.processLog(event.log);
  });

  return runtime;
}

export async function startApp(runtime: AppRuntime): Promise<void> {
  if (runtime.config.ruleFiles && runtime.config.ruleFiles.length > 0) {
    const rules = await runtime.ruleManager.loadRuleFiles(runtime.config.ruleFiles);
    console.info(`[App] Loaded ${rules.length} rules from ${runtime.config.ruleFiles.length} files`);
  }

  if (runtime.config.inputSources && runtime.config.inputSources.length > 0) {
    await runtime.inputManager.startSources(runtime.config.inputSources);
    console.info(`[App] Started ${runtime.config.inputSources.length} input sources`);
  }
}

export async function stopApp(runtime: AppRuntime): Promise<void> {
  await runtime.inputManager.stop();
  runtime.ruleManager.stop();
}

export function loadAppConfig(configPath?: string): AppConfig {
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (fs.existsSync(resolved)) {
      return parseConfigFile(resolved);
    }
  }
  return {
    inputSources: [],
    ruleFiles: [],
    globalOutputs: [{ type: 'console', color: true }],
    httpApiPort: 3000,
    dryRun: false,
    timezone: 'UTC'
  };
}

function parseConfigFile(configPath: string): AppConfig {
  const content = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(content) as any;
  const configDir = path.dirname(path.resolve(configPath));

  const resolveRelative = (p: string): string => {
    if (path.isAbsolute(p)) return p;
    return path.resolve(configDir, p);
  };

  const inputSources: InputSource[] = [];
  if (parsed.input_sources && Array.isArray(parsed.input_sources)) {
    for (const raw of parsed.input_sources) {
      inputSources.push(convertInputSource(raw, resolveRelative));
    }
  }

  const ruleFiles: string[] = [];
  if (parsed.rule_files) {
    if (Array.isArray(parsed.rule_files)) {
      ruleFiles.push(...parsed.rule_files.map(resolveRelative));
    } else if (typeof parsed.rule_files === 'string') {
      ruleFiles.push(resolveRelative(parsed.rule_files));
    }
  }

  const globalOutputs: OutputChannel[] = [];
  if (parsed.global_outputs && Array.isArray(parsed.global_outputs)) {
    for (const raw of parsed.global_outputs) {
      globalOutputs.push(convertOutput(raw));
    }
  }
  if (globalOutputs.length === 0) {
    globalOutputs.push({ type: 'console', color: true });
  }

  return {
    inputSources,
    ruleFiles,
    globalOutputs,
    httpApiPort: parsed.http_api_port || 3000,
    dryRun: parsed.dry_run || false,
    timezone: parsed.timezone || 'UTC'
  };
}

function convertInputSource(raw: any, resolveRelative?: (p: string) => string): InputSource {
  const type = raw.type || 'file';
  const parserConfig: ParserConfig = convertParserConfig(raw.parser_config || {});

  switch (type) {
    case 'stdin':
      return {
        type: 'stdin',
        id: raw.id || 'stdin',
        parserConfig
      };
    case 'kafka':
      return {
        type: 'kafka',
        id: raw.id || 'kafka',
        brokers: raw.brokers || [],
        topic: raw.topic || '',
        groupId: raw.group_id || 'log-alert',
        parserConfig
      };
    case 'http':
      return {
        type: 'http',
        id: raw.id || 'http',
        port: raw.port,
        parserConfig
      };
    case 'file':
    default:
      return {
        type: 'file',
        id: raw.id || `file_${raw.path || 'default'}`,
        path: (raw.path && resolveRelative) ? resolveRelative(raw.path) : (raw.path || ''),
        pattern: raw.pattern,
        parserConfig
      };
  }
}

function convertParserConfig(raw: any): ParserConfig {
  return {
    format: raw.format,
    grokPattern: raw.grok_pattern,
    regexPattern: raw.regex_pattern,
    timeField: raw.time_field,
    levelField: raw.level_field,
    source: raw.source,
    customPatterns: raw.custom_patterns
  };
}

function convertOutput(raw: any): OutputChannel {
  switch (raw.type) {
    case 'webhook':
      return { type: 'webhook', url: raw.url, headers: raw.headers };
    case 'http':
      return {
        type: 'http',
        method: raw.method || 'POST',
        url: raw.url,
        headers: raw.headers,
        bodyTemplate: raw.body_template
      };
    case 'console':
    default:
      return { type: 'console', color: raw.color !== false };
  }
}

export function mergeParserConfigWithCLI(base: ParserConfig, cli: {
  format?: string;
  grok?: string;
  regex?: string;
  source?: string;
  timeField?: string;
  levelField?: string;
}): ParserConfig {
  const result: ParserConfig = { ...base };
  if (cli.format) result.format = cli.format as ParserConfig['format'];
  if (cli.grok) {
    result.format = 'grok';
    result.grokPattern = cli.grok;
  }
  if (cli.regex) {
    result.format = 'regex';
    result.regexPattern = cli.regex;
  }
  if (cli.source) result.source = cli.source;
  if (cli.timeField) result.timeField = cli.timeField;
  if (cli.levelField) result.levelField = cli.levelField;
  return result;
}
