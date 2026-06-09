#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  createAppRuntime,
  startApp,
  stopApp,
  loadAppConfig,
  AppRuntime,
  mergeParserConfigWithCLI
} from '../app/runtime';
import { ApiServer } from '../app/api';
import { inferFormat, saveInferredConfig } from '../inferrer';
import { LogParser } from '../parser';
import { AlertRuleEngine } from '../engine';
import { ParserConfig, AppConfig, InputSource, StdinInputSource, FileInputSource, AlertRule } from '../types';
import * as yaml from 'js-yaml';

const program = new Command();

program
  .name('log-alert')
  .description('日志结构化解析与智能告警规则引擎')
  .version('1.0.0');

program
  .command('run')
  .description('启动日志告警引擎，消费日志流并处理告警')
  .option('-c, --config <path>', '配置文件路径(YAML)')
  .option('-f, --file <path>', '监听的日志文件路径(支持glob)')
  .option('-r, --rules <path>', '规则文件路径')
  .option('-s, --stdin', '从stdin读取日志')
  .option('-k, --kafka <brokers>', 'Kafka broker地址(逗号分隔)')
  .option('-t, --topic <topic>', 'Kafka topic')
  .option('-g, --group <groupId>', 'Kafka consumer group', 'log-alert-cli')
  .option('--format <format>', '日志格式: nginx/apache/syslog/json/grok/regex')
  .option('--grok <pattern>', '自定义Grok模式')
  .option('--regex <pattern>', '自定义正则表达式(命名捕获组)')
  .option('--source <name>', '日志来源标识')
  .option('--time-field <field>', '时间字段名')
  .option('--level-field <field>', '日志级别字段名')
  .option('--api-port <port>', 'HTTP API端口', '3000')
  .option('--no-api', '禁用HTTP API')
  .option('--webhook <url>', 'Webhook告警推送URL')
  .option('--dry-run', '测试模式，不真正发送告警')
  .option('--timezone <tz>', '时区', 'UTC')
  .action(async (opts) => {
    try {
      let config: AppConfig;
      if (opts.config) {
        config = loadAppConfig(opts.config);
      } else {
        config = {
          inputSources: [],
          ruleFiles: opts.rules ? [opts.rules] : [],
          globalOutputs: [{ type: 'console', color: true }],
          httpApiPort: parseInt(opts.apiPort, 10),
          dryRun: opts.dryRun || false,
          timezone: opts.timezone
        };
      }

      if (opts.dryRun) config.dryRun = true;
      if (opts.timezone) config.timezone = opts.timezone;
      if (opts.rules && !config.ruleFiles.includes(opts.rules)) {
        config.ruleFiles.push(opts.rules);
      }
      if (opts.apiPort) config.httpApiPort = parseInt(opts.apiPort, 10);

      if (opts.webhook) {
        config.globalOutputs = config.globalOutputs || [];
        config.globalOutputs.push({ type: 'webhook', url: opts.webhook });
      }

      const cliParser: ParserConfig = mergeParserConfigWithCLI(
        { format: opts.format ? (opts.format as any) : undefined, source: opts.source },
        {
          format: opts.format,
          grok: opts.grok,
          regex: opts.regex,
          source: opts.source,
          timeField: opts.timeField,
          levelField: opts.levelField
        }
      );

      const sources: InputSource[] = [];

      if (opts.file) {
        const src: FileInputSource = {
          type: 'file',
          id: `file_${path.basename(opts.file)}`,
          path: opts.file,
          parserConfig: cliParser
        };
        sources.push(src);
      }

      if (opts.stdin || (!opts.file && !opts.kafka && !opts.config)) {
        const src: StdinInputSource = {
          type: 'stdin',
          id: 'stdin',
          parserConfig: cliParser
        };
        sources.push(src);
      }

      if (opts.kafka) {
        if (!opts.topic) {
          console.error('错误: 使用Kafka必须指定 --topic');
          process.exit(1);
        }
        sources.push({
          type: 'kafka',
          id: 'kafka',
          brokers: opts.kafka.split(','),
          topic: opts.topic,
          groupId: opts.group,
          parserConfig: cliParser
        });
      }

      if (sources.length > 0) {
        config.inputSources = sources;
      }

      if (config.inputSources.length === 0 && (!config.ruleFiles || config.ruleFiles.length === 0)) {
        console.error('错误: 必须指定至少一个输入源 (-f/-s/-k) 或规则文件 (-r/配置文件)');
        process.exit(1);
      }

      const runtime = createAppRuntime(config);
      await startApp(runtime);

      let apiServer: ApiServer | null = null;
      if (opts.api !== false) {
        apiServer = new ApiServer(runtime, { port: config.httpApiPort });
        try {
          await apiServer.start();
        } catch (e) {
          console.warn('警告: API服务启动失败，继续运行但无API:', (e as Error).message);
        }
      }

      const shutdown = async (signal: string) => {
        console.info(`\n收到 ${signal}，正在优雅关闭...`);
        if (apiServer) await apiServer.stop();
        await stopApp(runtime);
        console.info('已关闭');
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (e) {
      console.error('运行错误:', e);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('仅启动API服务和规则引擎，无日志输入(等待HTTP推送)')
  .option('-c, --config <path>', '配置文件路径')
  .option('-r, --rules <path>', '规则文件路径')
  .option('--api-port <port>', 'HTTP API端口', '3000')
  .option('--dry-run', '测试模式')
  .option('--timezone <tz>', '时区', 'UTC')
  .action(async (opts) => {
    try {
      const config = loadAppConfig(opts.config);
      if (opts.rules) config.ruleFiles = [opts.rules];
      if (opts.apiPort) config.httpApiPort = parseInt(opts.apiPort, 10);
      if (opts.dryRun) config.dryRun = true;
      if (opts.timezone) config.timezone = opts.timezone;

      config.inputSources.push({
        type: 'http',
        id: 'http_default',
        parserConfig: { format: 'json' }
      });

      const runtime = createAppRuntime(config);
      await startApp(runtime);

      const apiServer = new ApiServer(runtime, { port: config.httpApiPort });
      await apiServer.start();

      const shutdown = async (signal: string) => {
        console.info(`\n收到 ${signal}，正在关闭...`);
        await apiServer.stop();
        await stopApp(runtime);
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } catch (e) {
      console.error('错误:', e);
      process.exit(1);
    }
  });

program
  .command('infer')
  .description('分析日志样本，自动推断日志格式')
  .argument('<sample-file>', '日志样本文件路径(至少20行)')
  .option('-n, --max-suggestions <n>', '候选模式数量', '5')
  .option('-o, --output <path>', '保存推断结果为配置文件')
  .action(async (sampleFile, opts) => {
    try {
      const resolvedPath = path.resolve(sampleFile);
      if (!fs.existsSync(resolvedPath)) {
        console.error(`文件不存在: ${resolvedPath}`);
        process.exit(1);
      }

      const lines: string[] = [];
      const rl = readline.createInterface({
        input: fs.createReadStream(resolvedPath),
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (lines.length >= 200) break;
        if (line.trim()) lines.push(line.trim());
      }

      if (lines.length < 10) {
        console.error(`样本行数不足: ${lines.length} 行，至少需要 10 行`);
        process.exit(1);
      }

      console.log(`分析 ${lines.length} 行日志样本...\n`);

      const result = inferFormat(lines, parseInt(opts.maxSuggestions, 10));

      console.log('=== 候选格式建议 ===');
      if (result.suggestions.length === 0) {
        console.log('未匹配到任何内置格式');
      } else {
        result.suggestions.forEach((s, i) => {
          console.log(`\n#${i + 1} ${s.name}`);
          console.log(`  匹配率: ${(s.matchRate * 100).toFixed(1)}% (${s.matchedCount}/${s.totalCount})`);
          console.log(`  模式: ${s.pattern.substring(0, 120)}${s.pattern.length > 120 ? '...' : ''}`);
          if (s.sampleMatches.length > 0) {
            console.log('  示例匹配:');
            s.sampleMatches.forEach(sm => {
              const fieldStr = Object.entries(sm.match)
                .slice(0, 5)
                .map(([k, v]) => `${k}=${String(v).substring(0, 30)}`)
                .join(', ');
              console.log(`    - ${fieldStr}`);
            });
          }
        });
      }

      if (result.autoGeneratedPattern) {
        console.log('\n=== 自动生成草稿模式 ===');
        console.log(`匹配率: ${((result.autoGeneratedMatchRate || 0) * 100).toFixed(1)}%`);
        console.log(`Grok: ${result.autoGeneratedPattern}`);
      }

      if (opts.output) {
        const outPath = path.resolve(opts.output);
        const content = saveInferredConfig(result, outPath);
        console.log(`\n配置已保存到: ${outPath}`);
      }

    } catch (e) {
      console.error('推断错误:', e);
      process.exit(1);
    }
  });

program
  .command('parse')
  .description('测试日志解析，输出结构化结果')
  .argument('<input-file>', '日志文件路径，或使用 - 表示stdin')
  .option('--format <format>', '日志格式: nginx/apache/syslog/json/grok/regex')
  .option('--grok <pattern>', 'Grok模式')
  .option('--regex <pattern>', '自定义正则')
  .option('--source <name>', '来源标识')
  .option('--time-field <field>', '时间字段')
  .option('--level-field <field>', '级别字段')
  .option('-n, --lines <n>', '处理行数', '0')
  .option('--timezone <tz>', '时区', 'UTC')
  .option('--json', 'JSON格式输出')
  .action(async (inputFile, opts) => {
    try {
      const parserConfig: ParserConfig = mergeParserConfigWithCLI({}, {
        format: opts.format,
        grok: opts.grok,
        regex: opts.regex,
        source: opts.source,
        timeField: opts.timeField,
        levelField: opts.levelField
      });

      const parser = new LogParser(parserConfig, opts.timezone);
      const maxLines = parseInt(opts.lines, 10);
      let inputStream: NodeJS.ReadableStream;

      if (inputFile === '-') {
        inputStream = process.stdin;
      } else {
        const resolved = path.resolve(inputFile);
        if (!fs.existsSync(resolved)) {
          console.error(`文件不存在: ${resolved}`);
          process.exit(1);
        }
        inputStream = fs.createReadStream(resolved);
      }

      const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
      const results: any[] = [];
      let count = 0;
      let errors = 0;

      for await (const line of rl) {
        if (!line.trim()) continue;
        if (maxLines > 0 && count >= maxLines) break;

        const result = parser.parseLine(line);
        count++;

        if (result.log) {
          if (opts.json) {
            results.push(result.log);
          } else {
            console.log(`[OK] ${result.log.timestamp} ${result.log.level} ${result.log.source}`);
            console.log(`  message: ${result.log.message.substring(0, 100)}`);
            const fieldEntries = Object.entries(result.log.fields).slice(0, 8);
            if (fieldEntries.length > 0) {
              console.log('  fields:');
              for (const [k, v] of fieldEntries) {
                console.log(`    ${k}: ${String(v).substring(0, 50)}`);
              }
            }
          }
        } else {
          errors++;
          if (!opts.json) {
            console.log(`[FAIL] ${result.error}: ${line.substring(0, 80)}`);
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`\n总计: ${count} 行，成功: ${count - errors}，失败: ${errors}`);
        if (errors > 0) {
          const recentErrors = parser.getErrors().slice(0, 5);
          console.log('\n最近解析错误:');
          recentErrors.forEach(e => {
            console.log(`  - [${new Date(e.timestamp).toISOString()}] ${e.error}: ${e.line.substring(0, 80)}`);
          });
        }
      }

    } catch (e) {
      console.error('解析错误:', e);
      process.exit(1);
    }
  });

program
  .command('test-rules')
  .description('用历史日志测试规则，输出命中情况')
  .argument('<log-file>', '历史日志文件')
  .requiredOption('-r, --rules <path>', '规则文件YAML')
  .option('--format <format>', '日志格式')
  .option('--grok <pattern>', 'Grok模式')
  .option('--regex <pattern>', '自定义正则')
  .option('--source <name>', '来源标识')
  .option('--timezone <tz>', '时区', 'UTC')
  .option('--json', 'JSON格式输出')
  .action(async (logFile, opts) => {
    try {
      const rulesPath = path.resolve(opts.rules);
      if (!fs.existsSync(rulesPath)) {
        console.error(`规则文件不存在: ${rulesPath}`);
        process.exit(1);
      }
      const rulesContent = fs.readFileSync(rulesPath, 'utf8');
      const rawRules = yaml.load(rulesContent) as any[];
      const rulesArr = Array.isArray(rawRules) ? rawRules : [rawRules];

      const runtime = createAppRuntime({
        inputSources: [],
        ruleFiles: [],
        globalOutputs: [],
        dryRun: true,
        timezone: opts.timezone
      });

      const { RuleManager } = require('../rules');
      const ruleManager = new RuleManager(runtime.ruleEngine, runtime.outputDispatcher, { dryRun: true });
      const rules = await ruleManager.loadRuleFiles([rulesPath]);

      const parserConfig: ParserConfig = mergeParserConfigWithCLI({}, {
        format: opts.format,
        grok: opts.grok,
        regex: opts.regex,
        source: opts.source
      });
      const parser = new LogParser(parserConfig, opts.timezone);

      const ruleHits: Record<string, { count: number; samples: string[]; timestamps: number[] }> = {};
      rules.forEach((r: AlertRule) => { ruleHits[r.id] = { count: 0, samples: [], timestamps: [] }; });

      const alertTimeline: Array<{ time: number; rule_id: string; severity: string }> = [];
      const allAlerts: any[] = [];

      runtime.ruleEngine.onAlert(alert => {
        allAlerts.push(alert);
        alertTimeline.push({
          time: alert.triggeredAt,
          rule_id: alert.ruleId,
          severity: alert.severity
        });
        if (ruleHits[alert.ruleId]) {
          ruleHits[alert.ruleId].count++;
          ruleHits[alert.ruleId].timestamps.push(alert.triggeredAt);
          if (ruleHits[alert.ruleId].samples.length < 5 && alert.logs.length > 0) {
            ruleHits[alert.ruleId].samples.push(alert.logs[0].message.substring(0, 150));
          }
        }
      });

      const resolvedLog = path.resolve(logFile);
      if (!fs.existsSync(resolvedLog)) {
        console.error(`日志文件不存在: ${resolvedLog}`);
        process.exit(1);
      }

      const rl = readline.createInterface({
        input: fs.createReadStream(resolvedLog),
        crlfDelay: Infinity
      });

      let totalLines = 0;
      let parsedLines = 0;

      for await (const line of rl) {
        if (!line.trim()) continue;
        totalLines++;
        const result = parser.parseLine(line);
        if (result.log) {
          parsedLines++;
          runtime.ruleEngine.processLog(result.log);
        }
      }

      if (opts.json) {
        const output = {
          summary: {
            total_lines: totalLines,
            parsed_lines: parsedLines,
            parse_rate: totalLines > 0 ? parsedLines / totalLines : 0,
            total_alerts: allAlerts.length,
            rules_evaluated: rules.length
          },
          rule_hits: Object.entries(ruleHits).map(([id, h]) => ({
            rule_id: id,
            rule_name: rules.find((r: AlertRule) => r.id === id)?.name,
            hit_count: h.count,
            samples: h.samples,
            timestamps: h.timestamps
          })),
          alert_timeline: alertTimeline,
          alerts: allAlerts.slice(0, 200)
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(`=== 测试结果 ===`);
        console.log(`总日志行数: ${totalLines}`);
        console.log(`成功解析: ${parsedLines} (${totalLines > 0 ? ((parsedLines / totalLines) * 100).toFixed(1) : 0}%)`);
        console.log(`触发告警总数: ${allAlerts.length}\n`);
        console.log(`规则命中详情:`);
        for (const [id, h] of Object.entries(ruleHits)) {
          const rule = rules.find((r: AlertRule) => r.id === id);
          console.log(`\n  [${rule?.severity.toUpperCase()}] ${rule?.name} (${id})`);
          console.log(`    命中: ${h.count} 次`);
          if (h.timestamps.length > 1) {
            const intervals: number[] = [];
            for (let i = 1; i < h.timestamps.length; i++) {
              intervals.push(h.timestamps[i] - h.timestamps[i - 1]);
            }
            const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
            console.log(`    平均间隔: ${(avg / 1000).toFixed(1)}s`);
          }
          if (h.samples.length > 0) {
            console.log(`    示例日志:`);
            h.samples.forEach(s => console.log(`      - ${s}`));
          }
        }

        if (alertTimeline.length > 0) {
          console.log(`\n告警时间线 (前20条):`);
          alertTimeline.slice(0, 20).forEach(a => {
            console.log(`  ${new Date(a.time).toISOString()} [${a.severity}] ${a.rule_id}`);
          });
        }
      }

    } catch (e) {
      console.error('错误:', e);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch(err => {
  console.error(err);
  process.exit(1);
});
