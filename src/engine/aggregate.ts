import { AggregateCondition, StructuredLog, Condition } from '../types';
import { evaluateCondition } from './conditions';

interface WindowBucket {
  startTime: number;
  endTime: number;
  logs: StructuredLog[];
  count: number;
  sum: number;
  groupCounts: Map<string, { count: number; sum: number; logs: StructuredLog[] }>;
}

export interface AggregateResult {
  triggered: boolean;
  groupKey?: string;
  matchedLogs: StructuredLog[];
  count: number;
  value: number;
}

export class AggregateRuleEngine {
  private condition: AggregateCondition;
  private ringBuffer: WindowBucket[] = [];
  private bufferSize: number;
  private lastFireTime: Map<string, number> = new Map();

  constructor(condition: AggregateCondition) {
    this.condition = condition;
    this.bufferSize = Math.ceil(condition.windowSeconds / condition.slideSeconds) + 2;
  }

  process(log: StructuredLog, now: number = Date.now()): AggregateResult[] {
    this.evictOldBuckets(now);

    const baseMatch = evaluateCondition(this.condition.baseCondition, log);
    if (!baseMatch.matched) {
      return this.checkAllWindows(now, false);
    }

    const slideMs = this.condition.slideSeconds * 1000;
    const bucketStart = Math.floor(log.timestamp / slideMs) * slideMs;
    const bucketEnd = bucketStart + slideMs;

    let bucket = this.ringBuffer.find(b => b.startTime === bucketStart);
    if (!bucket) {
      bucket = {
        startTime: bucketStart,
        endTime: bucketEnd,
        logs: [],
        count: 0,
        sum: 0,
        groupCounts: new Map()
      };
      this.ringBuffer.push(bucket);
      if (this.ringBuffer.length > this.bufferSize * 2) {
        this.ringBuffer.sort((a, b) => a.startTime - b.startTime);
        this.ringBuffer = this.ringBuffer.slice(-this.bufferSize);
      }
    }

    bucket.logs.push(log);
    bucket.count++;

    if (this.condition.aggregation === 'sum' || this.condition.aggregation === 'avg') {
      const fieldVal = this.getAggregateFieldValue(log);
      if (typeof fieldVal === 'number') {
        bucket.sum += fieldVal;
      }
    }

    if (this.condition.groupBy && this.condition.groupBy.length > 0) {
      const key = this.buildGroupKey(log);
      let groupData = bucket.groupCounts.get(key);
      if (!groupData) {
        groupData = { count: 0, sum: 0, logs: [] };
        bucket.groupCounts.set(key, groupData);
      }
      groupData.count++;
      groupData.logs.push(log);
      if (this.condition.aggregation === 'sum' || this.condition.aggregation === 'avg') {
        const fieldVal = this.getAggregateFieldValue(log);
        if (typeof fieldVal === 'number') {
          groupData.sum += fieldVal;
        }
      }
    }

    return this.checkAllWindows(now, true);
  }

  private evictOldBuckets(now: number): void {
    const windowMs = this.condition.windowSeconds * 1000;
    const cutoff = now - windowMs;
    this.ringBuffer = this.ringBuffer.filter(b => b.endTime > cutoff);
  }

  private getAggregateFieldValue(log: StructuredLog): number {
    if (!this.condition.aggregateField) return 0;
    const val = this.resolveFieldPath(log, this.condition.aggregateField);
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && !isNaN(parseFloat(val))) return parseFloat(val);
    return 0;
  }

  private resolveFieldPath(log: StructuredLog, field: string): any {
    if (field === 'timestamp') return log.timestamp;
    if (field === 'level') return log.level;
    if (field === 'source') return log.source;
    if (field === 'message') return log.message;
    let effective = field;
    if (effective.startsWith('fields.')) effective = effective.substring(7);
    const parts = effective.split('.');
    let current: any = log.fields;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  private buildGroupKey(log: StructuredLog): string {
    const keys: string[] = [];
    for (const field of (this.condition.groupBy || [])) {
      const val = this.resolveFieldPath(log, field);
      keys.push(String(val ?? ''));
    }
    return keys.join('|');
  }

  private checkAllWindows(now: number, _newData: boolean): AggregateResult[] {
    const results: AggregateResult[] = [];
    const windowMs = this.condition.windowSeconds * 1000;
    const windowStart = now - windowMs;

    const relevantBuckets = this.ringBuffer.filter(b => b.endTime > windowStart && b.startTime < now);
    if (relevantBuckets.length === 0) return results;

    if (this.condition.groupBy && this.condition.groupBy.length > 0) {
      const groupAggregates: Map<string, { count: number; sum: number; logs: StructuredLog[] }> = new Map();

      for (const bucket of relevantBuckets) {
        for (const [key, data] of bucket.groupCounts.entries()) {
          let agg = groupAggregates.get(key);
          if (!agg) {
            agg = { count: 0, sum: 0, logs: [] };
            groupAggregates.set(key, agg);
          }
          agg.count += data.count;
          agg.sum += data.sum;
          agg.logs.push(...data.logs);
        }
      }

      for (const [groupKey, agg] of groupAggregates.entries()) {
        let value = agg.count;
        if (this.condition.aggregation === 'sum') value = agg.sum;
        if (this.condition.aggregation === 'avg') value = agg.count > 0 ? agg.sum / agg.count : 0;

        if (value >= this.condition.threshold) {
          const fireKey = `${groupKey}:${Math.floor(now / (this.condition.slideSeconds * 1000))}`;
          const lastFire = this.lastFireTime.get(groupKey) || 0;
          if (now - lastFire >= this.condition.slideSeconds * 1000 * 0.5) {
            this.lastFireTime.set(groupKey, now);
            results.push({
              triggered: true,
              groupKey,
              matchedLogs: agg.logs,
              count: agg.count,
              value
            });
          }
        }
      }
    } else {
      let totalCount = 0;
      let totalSum = 0;
      const allLogs: StructuredLog[] = [];

      for (const bucket of relevantBuckets) {
        totalCount += bucket.count;
        totalSum += bucket.sum;
        allLogs.push(...bucket.logs);
      }

      let value = totalCount;
      if (this.condition.aggregation === 'sum') value = totalSum;
      if (this.condition.aggregation === 'avg') value = totalCount > 0 ? totalSum / totalCount : 0;

      if (value >= this.condition.threshold) {
        const lastFire = this.lastFireTime.get('__global__') || 0;
        if (now - lastFire >= this.condition.slideSeconds * 1000 * 0.5) {
          this.lastFireTime.set('__global__', now);
          results.push({
            triggered: true,
            matchedLogs: allLogs,
            count: totalCount,
            value
          });
        }
      }
    }

    return results;
  }

  reset(): void {
    this.ringBuffer = [];
    this.lastFireTime.clear();
  }

  getCurrentStats(now: number = Date.now()): { count: number; groups: string[] } {
    const windowMs = this.condition.windowSeconds * 1000;
    const windowStart = now - windowMs;
    const relevantBuckets = this.ringBuffer.filter(b => b.endTime > windowStart && b.startTime < now);

    let count = 0;
    const groups = new Set<string>();
    for (const bucket of relevantBuckets) {
      count += bucket.count;
      for (const key of bucket.groupCounts.keys()) {
        groups.add(key);
      }
    }

    return { count, groups: Array.from(groups) };
  }
}
