import { AlertRule, Condition, OutputChannel, ParserConfig, InputSource, Severity, ComparisonOperator, CompositeOperator, AggregateCondition, SequenceCondition } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as yaml from 'js-yaml';
import { EventEmitter } from 'events';
import { AlertRuleEngine } from '../engine';
import { OutputDispatcher } from '../outputs';
import { ChangeType, RulesChangedEvent, deepClone } from '../versions';

function deepCloneRules(rules: AlertRule[]): AlertRule[] {
  return deepClone(rules);
}

export interface RuleManagerOptions {
  dryRun?: boolean;
  onRulesReloaded?: (rules: AlertRule[]) => void;
}

interface RawAlertRule {
  id: string;
  name: string;
  description?: string;
  severity: Severity;
  priority?: number;
  enabled?: boolean;
  condition: RawCondition;
  actions?: RawOutputChannel[];
  cooldown_seconds?: number;
  depends_on?: string[];
  escalation?: { to_severity: Severity; after_seconds: number };
  recovery_notification?: boolean;
  dedup?: { window_seconds: number; hash_prefix_length?: number };
  top_n?: { window_seconds: number; n: number; field?: string };
}

type RawCondition = RawSimpleCondition | RawCompositeCondition | RawAggregateCondition | RawSequenceCondition;

interface RawSimpleCondition {
  type?: 'simple';
  field: string;
  operator: ComparisonOperator;
  value: any;
}

interface RawCompositeCondition {
  type?: 'composite';
  operator: CompositeOperator;
  conditions: RawCondition[];
}

interface RawAggregateCondition {
  type: 'aggregate';
  window_seconds: number;
  slide_seconds?: number;
  threshold: number;
  group_by?: string[];
  base_condition: RawCondition;
  aggregation?: 'count' | 'sum' | 'avg';
  aggregate_field?: string;
}

interface RawSequenceCondition {
  type: 'sequence';
  key_field: string;
  events: Array<{ event_id: string; condition: RawCondition; timeout_seconds: number }>;
  max_total_seconds: number;
}

type RawOutputChannel =
  | { type: 'webhook'; url: string; headers?: Record<string, string>; template_id?: string; body_template?: string }
  | { type: 'console'; color?: boolean }
  | { type: 'http'; method: 'GET' | 'POST' | 'PUT'; url: string; headers?: Record<string, string>; body_template?: string; template_id?: string };

export class RuleManager extends EventEmitter {
  private ruleFiles: string[] = [];
  private watchers: chokidar.FSWatcher[] = [];
  private engine: AlertRuleEngine;
  private outputDispatcher: OutputDispatcher;
  private options: RuleManagerOptions;
  private rules: AlertRule[] = [];
  private isReloading: boolean = false;

  constructor(
    engine: AlertRuleEngine,
    outputDispatcher: OutputDispatcher,
    options: RuleManagerOptions = {}
  ) {
    super();
    this.engine = engine;
    this.outputDispatcher = outputDispatcher;
    this.options = options;
  }

  emitRulesChanged(event: Omit<RulesChangedEvent, 'timestamp'>): void {
    this.emit('rulesChanged', event);
  }

  onRulesChanged(listener: (event: RulesChangedEvent) => void): this {
    this.on('rulesChanged', listener);
    return this;
  }

  async loadRuleFiles(filePaths: string[]): Promise<AlertRule[]> {
    this.ruleFiles = filePaths;
    const allRules: AlertRule[] = [];

    for (const filePath of filePaths) {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn(`Rule file not found: ${resolvedPath}`);
        continue;
      }

      const rules = await this.loadFromFile(resolvedPath);
      allRules.push(...rules);
    }

    const rulesBefore = [...this.rules];
    const changedRuleIds = this.getChangedRuleIds(rulesBefore, allRules);
    this.rules = allRules;
    this.engine.loadRules(allRules);
    this.setupFileWatchers(filePaths);

    if (changedRuleIds.length > 0 || rulesBefore.length !== allRules.length) {
      this.emitRulesChanged({
        changeType: 'reload',
        changedRuleIds,
        rulesBefore,
        rulesAfter: allRules,
        operator: 'system'
      });
    }

    return allRules;
  }

  private async loadFromFile(filePath: string): Promise<AlertRule[]> {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(content);

    let rawRules: RawAlertRule[] = [];
    if (Array.isArray(parsed)) {
      rawRules = parsed as RawAlertRule[];
    } else if (parsed && typeof parsed === 'object') {
      if ((parsed as any).rules && Array.isArray((parsed as any).rules)) {
        rawRules = (parsed as any).rules as RawAlertRule[];
      } else {
        rawRules = [parsed as RawAlertRule];
      }
    }

    return rawRules.map(r => this.convertRule(r, filePath));
  }

  private convertRule(raw: RawAlertRule, sourceFile: string): AlertRule {
    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      severity: raw.severity,
      priority: raw.priority ?? 100,
      enabled: raw.enabled ?? true,
      condition: this.convertCondition(raw.condition),
      actions: (raw.actions || []).map(a => this.convertOutputChannel(a)),
      cooldownSeconds: raw.cooldown_seconds,
      dependsOn: raw.depends_on,
      escalation: raw.escalation ? {
        toSeverity: raw.escalation.to_severity,
        afterSeconds: raw.escalation.after_seconds
      } : undefined,
      recoveryNotification: raw.recovery_notification,
      dedup: raw.dedup ? {
        windowSeconds: raw.dedup.window_seconds,
        hashPrefixLength: raw.dedup.hash_prefix_length
      } : undefined,
      topN: raw.top_n ? {
        windowSeconds: raw.top_n.window_seconds,
        n: raw.top_n.n,
        field: raw.top_n.field
      } : undefined
    };
  }

  private convertCondition(raw: RawCondition): Condition {
    const type = (raw as any).type || 'simple';

    switch (type) {
      case 'composite': {
        const c = raw as RawCompositeCondition;
        return {
          type: 'composite',
          operator: c.operator,
          conditions: c.conditions.map(x => this.convertCondition(x))
        };
      }
      case 'aggregate': {
        const c = raw as RawAggregateCondition;
        return {
          type: 'aggregate',
          windowSeconds: c.window_seconds,
          slideSeconds: c.slide_seconds || Math.floor(c.window_seconds / 10),
          threshold: c.threshold,
          groupBy: c.group_by,
          baseCondition: this.convertCondition(c.base_condition),
          aggregation: c.aggregation || 'count',
          aggregateField: c.aggregate_field
        };
      }
      case 'sequence': {
        const c = raw as RawSequenceCondition;
        return {
          type: 'sequence',
          keyField: c.key_field,
          events: c.events.map(e => ({
            eventId: e.event_id,
            condition: this.convertCondition(e.condition),
            timeoutSeconds: e.timeout_seconds
          })),
          maxTotalSeconds: c.max_total_seconds
        };
      }
      case 'simple':
      default: {
        const c = raw as RawSimpleCondition;
        return {
          type: 'simple',
          field: c.field,
          operator: c.operator,
          value: c.value
        };
      }
    }
  }

  private convertOutputChannel(raw: RawOutputChannel): OutputChannel {
    switch (raw.type) {
      case 'webhook':
        return { type: 'webhook', url: raw.url, headers: raw.headers, templateId: raw.template_id, bodyTemplate: raw.body_template };
      case 'console':
        return { type: 'console', color: raw.color };
      case 'http':
        return {
          type: 'http',
          method: raw.method,
          url: raw.url,
          headers: raw.headers,
          bodyTemplate: raw.body_template,
          templateId: raw.template_id
        };
    }
  }

  private setupFileWatchers(filePaths: string[]): void {
    for (const filePath of filePaths) {
      const resolvedPath = path.resolve(filePath);
      const watcher = chokidar.watch(resolvedPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100
        }
      });

      watcher.on('change', () => this.handleFileChange());
      watcher.on('add', () => this.handleFileChange());

      this.watchers.push(watcher);
    }
  }

  private async handleFileChange(): Promise<void> {
    if (this.isReloading) return;
    this.isReloading = true;

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      console.info(`[RuleManager] Rules changed, reloading...`);
      const allRules: AlertRule[] = [];

      for (const filePath of this.ruleFiles) {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) continue;

        try {
          const rules = await this.loadFromFile(resolvedPath);
          allRules.push(...rules);
        } catch (e) {
          console.error(`Error reloading ${filePath}:`, e);
        }
      }

      const rulesBefore = [...this.rules];
      const existingIds = new Set(this.rules.map(r => r.id));
      const newIds = new Set(allRules.map(r => r.id));

      for (const removedId of Array.from(existingIds).filter(id => !newIds.has(id))) {
        this.engine.removeRule(removedId);
      }

      for (const rule of allRules) {
        if (existingIds.has(rule.id)) {
          this.engine.updateRule(rule);
        } else {
          this.engine.addRule(rule);
        }
      }

      this.rules = allRules;
      const changedRuleIds = this.getChangedRuleIds(rulesBefore, allRules);
      console.info(`[RuleManager] Loaded ${allRules.length} rules`);

      if (this.options.onRulesReloaded) {
        this.options.onRulesReloaded(allRules);
      }

      if (changedRuleIds.length > 0 || rulesBefore.length !== allRules.length) {
        this.emitRulesChanged({
          changeType: 'reload',
          changedRuleIds,
          rulesBefore,
          rulesAfter: allRules,
          operator: 'system'
        });
      }
    } catch (e) {
      console.error('Error reloading rules:', e);
    } finally {
      this.isReloading = false;
    }
  }

  getRules(): AlertRule[] {
    return [...this.rules];
  }

  getRule(id: string): AlertRule | undefined {
    return this.rules.find(r => r.id === id);
  }

  setRuleEnabled(id: string, enabled: boolean, operator: string = 'system'): boolean {
    const rule = this.getRule(id);
    if (!rule) return false;

    const rulesBefore = deepCloneRules(this.rules);
    const result = this.engine.setRuleEnabled(id, enabled);
    const rulesAfter = deepCloneRules(this.rules);

    if (result) {
      this.emitRulesChanged({
        changeType: enabled ? 'enable' : 'disable',
        changedRuleIds: [id],
        rulesBefore,
        rulesAfter,
        operator
      });
    }

    return result;
  }

  suppressRule(id: string, durationSeconds: number, operator: string = 'system'): boolean {
    const rule = this.getRule(id);
    if (!rule) return false;

    const rulesBefore = deepCloneRules(this.rules);
    const result = this.engine.suppressRule(id, durationSeconds);
    const rulesAfter = deepCloneRules(this.rules);

    if (result) {
      this.emitRulesChanged({
        changeType: 'update',
        changedRuleIds: [id],
        rulesBefore,
        rulesAfter,
        operator
      });
    }

    return result;
  }

  resetRuleState(id: string, operator: string = 'system'): void {
    const rule = this.getRule(id);
    if (!rule) return;

    const rulesBefore = deepCloneRules(this.rules);
    this.engine.resetRuleState(id);
    const rulesAfter = deepCloneRules(this.rules);

    this.emitRulesChanged({
      changeType: 'update',
      changedRuleIds: [id],
      rulesBefore,
      rulesAfter,
      operator
    });
  }

  replaceRules(newRules: AlertRule[]): { addedCount: number; removedCount: number; modifiedCount: number } {
    const rulesBefore = deepCloneRules(this.rules);
    const beforeMap = new Map(this.rules.map(r => [r.id, r]));
    const afterMap = new Map(newRules.map(r => [r.id, r]));

    let addedCount = 0;
    let removedCount = 0;
    let modifiedCount = 0;

    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        this.engine.removeRule(id);
        removedCount++;
      }
    }

    for (const [id, rule] of afterMap) {
      if (!beforeMap.has(id)) {
        this.engine.addRule(rule);
        addedCount++;
      } else {
        this.engine.updateRule(rule);
        modifiedCount++;
      }
    }

    this.rules = newRules;
    return { addedCount, removedCount, modifiedCount };
  }

  private getChangedRuleIds(before: AlertRule[], after: AlertRule[]): string[] {
    const changedIds = new Set<string>();
    const beforeMap = new Map(before.map(r => [r.id, r]));
    const afterMap = new Map(after.map(r => [r.id, r]));

    for (const [id] of afterMap) {
      if (!beforeMap.has(id)) {
        changedIds.add(id);
      }
    }
    for (const [id] of beforeMap) {
      if (!afterMap.has(id)) {
        changedIds.add(id);
      }
    }
    for (const [id, afterRule] of afterMap) {
      if (beforeMap.has(id)) {
        const beforeRule = beforeMap.get(id)!;
        if (JSON.stringify(beforeRule) !== JSON.stringify(afterRule)) {
          changedIds.add(id);
        }
      }
    }

    return Array.from(changedIds);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
