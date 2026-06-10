import { AlertRule, StructuredLog, TriggeredAlert, Severity, RuleStats, OutputChannel } from '../types';
import { evaluateCondition } from './conditions';
import { AggregateRuleEngine, AggregateResult } from './aggregate';
import { SequenceRuleEngine, SequenceResult } from './sequence';
import { v4 as uuidv4 } from 'uuid';

export interface RuleEngineOptions {
  dryRun?: boolean;
  defaultSeverity?: Severity;
}

export type SilenceCheckFn = (alert: TriggeredAlert, rule: AlertRule, now: number) => boolean;

interface RuleRuntimeState {
  aggregateEngine?: AggregateRuleEngine;
  sequenceEngine?: SequenceRuleEngine;
  stats: RuleStats;
  lastFiredAt: number;
  activeState: boolean;
  activeSince: number;
  suppressedUntil: number;
  dependencySuppressed: boolean;
  escalatedTo?: Severity;
  escalatedAt?: number;
  dedupWindow: Map<string, number>;
}

export class AlertRuleEngine {
  private rules: Map<string, AlertRule> = new Map();
  private ruleStates: Map<string, RuleRuntimeState> = new Map();
  private alertCallbacks: Array<(alert: TriggeredAlert) => void> = [];
  private silenceCheckFn?: SilenceCheckFn;
  private options: RuleEngineOptions;
  private triggeredAlerts: Map<string, TriggeredAlert> = new Map();
  private silencedAlerts: Array<{ alert: TriggeredAlert; ruleId: string; at: number }> = [];

  constructor(options: RuleEngineOptions = {}) {
    this.options = options;
  }

  setSilenceCheck(fn: SilenceCheckFn): void {
    this.silenceCheckFn = fn;
  }

  loadRules(rules: AlertRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);

    if (!this.ruleStates.has(rule.id)) {
      this.ruleStates.set(rule.id, {
        stats: {
          ruleId: rule.id,
          triggerCount: 0,
          silencedCount: 0,
          lastTriggeredAt: null,
          firstTriggeredAt: null,
          averageIntervalMs: null,
          intervals: []
        },
        lastFiredAt: 0,
        activeState: false,
        activeSince: 0,
        suppressedUntil: 0,
        dependencySuppressed: false,
        dedupWindow: new Map()
      });
    }

    const state = this.ruleStates.get(rule.id)!;
    if (rule.condition.type === 'aggregate') {
      state.aggregateEngine = new AggregateRuleEngine(rule.condition);
    } else if (rule.condition.type === 'sequence') {
      state.sequenceEngine = new SequenceRuleEngine(rule.condition);
    }
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    this.ruleStates.delete(ruleId);
  }

  updateRule(rule: AlertRule): void {
    this.removeRule(rule.id);
    this.addRule(rule);
  }

  getRule(ruleId: string): AlertRule | undefined {
    return this.rules.get(ruleId);
  }

  getAllRules(): AlertRule[] {
    return Array.from(this.rules.values()).sort((a, b) => a.priority - b.priority);
  }

  getRuleStats(ruleId: string): RuleStats | undefined {
    return this.ruleStates.get(ruleId)?.stats;
  }

  getAllStats(): RuleStats[] {
    return Array.from(this.ruleStates.values()).map(s => s.stats);
  }

  onAlert(callback: (alert: TriggeredAlert) => void): void {
    this.alertCallbacks.push(callback);
  }

  processLog(log: StructuredLog, now: number = Date.now()): TriggeredAlert[] {
    const triggered: TriggeredAlert[] = [];
    const sortedRules = this.getAllRules().filter(r => r.enabled);

    this.checkDependencies(sortedRules, now);

    for (const rule of sortedRules) {
      const state = this.ruleStates.get(rule.id);
      if (!state) continue;
      if (state.dependencySuppressed) continue;

      const results = this.evaluateRule(rule, state, log, now);
      for (const result of results) {
        if (result.triggered) {
          const alert = this.buildAlert(rule, state, result, now);
          if (alert) {
            if (this.silenceCheckFn && this.silenceCheckFn(alert, rule, now)) {
              state.stats.silencedCount++;
              this.silencedAlerts.push({ alert, ruleId: rule.id, at: now });
              if (this.silencedAlerts.length > 1000) {
                this.silencedAlerts.shift();
              }
              continue;
            }
            triggered.push(alert);
            this.emitAlert(alert);
          }
        }
      }

      if (rule.recoveryNotification) {
        this.checkRecovery(rule, state, log, now);
      }
    }

    return triggered;
  }

  private evaluateRule(
    rule: AlertRule,
    state: RuleRuntimeState,
    log: StructuredLog,
    now: number
  ): Array<{ triggered: boolean; matchedLogs?: StructuredLog[]; groupKey?: string; sequenceKey?: string }> {
    const results: Array<{ triggered: boolean; matchedLogs?: StructuredLog[]; groupKey?: string; sequenceKey?: string }> = [];

    switch (rule.condition.type) {
      case 'simple':
      case 'composite': {
        const match = evaluateCondition(rule.condition, log);
        if (match.matched) {
          const dedupKey = this.getDedupKey(rule, log);
          if (this.shouldTriggerDedup(rule, state, dedupKey, now)) {
            results.push({ triggered: true, matchedLogs: [log] });
          }
        }
        break;
      }
      case 'aggregate': {
        if (state.aggregateEngine) {
          const aggResults = state.aggregateEngine.process(log, now);
          for (const agg of aggResults) {
            if (agg.triggered) {
              results.push({
                triggered: true,
                matchedLogs: agg.matchedLogs,
                groupKey: agg.groupKey
              });
            }
          }
        }
        break;
      }
      case 'sequence': {
        if (state.sequenceEngine) {
          const seqResults = state.sequenceEngine.process(log, now);
          for (const seq of seqResults) {
            if (seq.triggered) {
              results.push({
                triggered: true,
                matchedLogs: seq.matchedLogs,
                sequenceKey: seq.sequenceKey
              });
            }
          }
        }
        break;
      }
    }

    return results;
  }

  private getDedupKey(rule: AlertRule, log: StructuredLog): string {
    if (!rule.dedup) return '__default__';
    const prefixLen = rule.dedup.hashPrefixLength || 32;
    let hashSource = log.message;
    if (rule.dedup.hashPrefixLength !== undefined) {
      let hash = 0;
      for (let i = 0; i < Math.min(prefixLen, log.message.length); i++) {
        hash = ((hash << 5) - hash) + log.message.charCodeAt(i);
        hash |= 0;
      }
      return String(hash);
    }
    return hashSource.substring(0, prefixLen);
  }

  private shouldTriggerDedup(rule: AlertRule, state: RuleRuntimeState, dedupKey: string, now: number): boolean {
    if (!rule.dedup) return true;
    const windowMs = rule.dedup.windowSeconds * 1000;
    const lastSeen = state.dedupWindow.get(dedupKey) || 0;
    if (now - lastSeen < windowMs) return false;
    state.dedupWindow.set(dedupKey, now);
    for (const [k, t] of state.dedupWindow.entries()) {
      if (now - t > windowMs * 2) {
        state.dedupWindow.delete(k);
      }
    }
    return true;
  }

  private buildAlert(
    rule: AlertRule,
    state: RuleRuntimeState,
    result: { triggered: boolean; matchedLogs?: StructuredLog[]; groupKey?: string; sequenceKey?: string },
    now: number
  ): TriggeredAlert | null {
    const cooldownMs = (rule.cooldownSeconds || 0) * 1000;
    if (now - state.lastFiredAt < cooldownMs) return null;
    if (now < state.suppressedUntil) return null;

    let severity = rule.severity;
    let originalSeverity = rule.severity;

    if (rule.escalation) {
      if (state.activeState && state.activeSince > 0) {
        const activeMs = now - state.activeSince;
        if (activeMs >= rule.escalation.afterSeconds * 1000) {
          severity = rule.escalation.toSeverity;
          if (!state.escalatedTo) {
            state.escalatedTo = rule.escalation.toSeverity;
            state.escalatedAt = now;
          }
        }
      }
    }

    state.lastFiredAt = now;
    state.activeState = true;
    if (state.activeSince === 0) {
      state.activeSince = now;
    }

    const stats = state.stats;
    const prevCount = stats.triggerCount;
    stats.triggerCount++;
    if (stats.firstTriggeredAt === null) stats.firstTriggeredAt = now;
    if (stats.lastTriggeredAt !== null) {
      stats.intervals.push(now - stats.lastTriggeredAt);
      if (stats.intervals.length > 100) stats.intervals.shift();
      const avg = stats.intervals.reduce((a, b) => a + b, 0) / stats.intervals.length;
      stats.averageIntervalMs = avg;
    }
    stats.lastTriggeredAt = now;

    const alertId = uuidv4();
    const alert: TriggeredAlert = {
      id: alertId,
      ruleId: rule.id,
      ruleName: rule.name,
      severity,
      originalSeverity,
      triggeredAt: now,
      logs: result.matchedLogs || [],
      extraFields: {
        ...(result.groupKey ? { groupKey: result.groupKey } : {}),
        ...(result.sequenceKey ? { sequenceKey: result.sequenceKey } : {})
      },
      sequenceKey: result.sequenceKey,
      groupKey: result.groupKey
    };

    this.triggeredAlerts.set(alertId, alert);
    return alert;
  }

  private emitAlert(alert: TriggeredAlert): void {
    if (this.options.dryRun) {
      console.warn(`[DRY-RUN] Alert would trigger: ${alert.ruleName} (${alert.severity})`);
    }
    for (const cb of this.alertCallbacks) {
      try {
        cb(alert);
      } catch (e) {
        console.error('Error in alert callback:', e);
      }
    }
  }

  private checkRecovery(
    rule: AlertRule,
    state: RuleRuntimeState,
    log: StructuredLog,
    now: number
  ): void {
    if (!state.activeState) return;

    if (rule.condition.type === 'simple' || rule.condition.type === 'composite') {
      const recoveryWindowMs = (rule.cooldownSeconds || 300) * 1000 * 2;
      if (now - state.lastFiredAt > recoveryWindowMs) {
        this.sendRecovery(rule, state, now);
      }
    }
  }

  private sendRecovery(rule: AlertRule, state: RuleRuntimeState, now: number): void {
    state.activeState = false;
    state.activeSince = 0;
    state.escalatedTo = undefined;
    state.escalatedAt = undefined;

    const alert: TriggeredAlert = {
      id: uuidv4(),
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      originalSeverity: rule.severity,
      triggeredAt: now,
      logs: [],
      extraFields: {},
      resolved: true,
      resolvedAt: now,
      isRecovery: true
    };

    this.emitAlert(alert);
  }

  private checkDependencies(rules: AlertRule[], now: number): void {
    for (const rule of rules) {
      const state = this.ruleStates.get(rule.id);
      if (!state) continue;

      state.dependencySuppressed = false;

      if (rule.dependsOn && rule.dependsOn.length > 0) {
        for (const depId of rule.dependsOn) {
          const depState = this.ruleStates.get(depId);
          const depRule = this.rules.get(depId);
          if (depState && depState.activeState && depRule) {
            const cooldownMs = (depRule.cooldownSeconds || 60) * 1000;
            if (now - depState.lastFiredAt < cooldownMs) {
              state.dependencySuppressed = true;
              break;
            }
          }
        }
      }
    }
  }

  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;
    rule.enabled = enabled;
    return true;
  }

  getActiveAlerts(): TriggeredAlert[] {
    return Array.from(this.triggeredAlerts.values()).filter(a => !a.resolved);
  }

  getAllAlerts(limit: number = 100): TriggeredAlert[] {
    return Array.from(this.triggeredAlerts.values()).slice(-limit);
  }

  resetRuleState(ruleId: string): void {
    const state = this.ruleStates.get(ruleId);
    if (!state) return;
    state.activeState = false;
    state.activeSince = 0;
    state.lastFiredAt = 0;
    state.suppressedUntil = 0;
    state.dependencySuppressed = false;
    state.escalatedTo = undefined;
    state.escalatedAt = undefined;
    state.dedupWindow.clear();
    state.aggregateEngine?.reset();
    state.sequenceEngine?.reset();
  }

  suppressRule(ruleId: string, durationSeconds: number): boolean {
    const state = this.ruleStates.get(ruleId);
    if (!state) return false;
    state.suppressedUntil = Date.now() + durationSeconds * 1000;
    return true;
  }

  getSilencedAlerts(limit: number = 100): Array<{ alert: TriggeredAlert; ruleId: string; at: number }> {
    return this.silencedAlerts.slice(-limit);
  }

  getTotalSilencedCount(): number {
    let total = 0;
    for (const state of this.ruleStates.values()) {
      total += state.stats.silencedCount;
    }
    return total;
  }
}
