import { SequenceCondition, SequenceEvent, StructuredLog } from '../types';
import { evaluateCondition } from './conditions';

interface FSMState {
  key: string;
  currentEventIndex: number;
  lastEventTime: number;
  startTime: number;
  matchedLogs: StructuredLog[];
}

export interface SequenceResult {
  triggered: boolean;
  sequenceKey: string;
  matchedLogs: StructuredLog[];
  eventId: string;
}

export class SequenceRuleEngine {
  private condition: SequenceCondition;
  private fsmInstances: Map<string, FSMState> = new Map();
  private lastFireTime: Map<string, number> = new Map();
  private cooldownMs: number = 1000;

  constructor(condition: SequenceCondition) {
    this.condition = condition;
  }

  process(log: StructuredLog, now: number = Date.now()): SequenceResult[] {
    const results: SequenceResult[] = [];

    const key = this.extractKeyValue(log);
    if (key === null) return results;

    this.cleanupExpiredInstances(now);

    for (let i = 0; i < this.condition.events.length; i++) {
      const event = this.condition.events[i];
      const match = evaluateCondition(event.condition, log);
      if (!match.matched) continue;

      const instanceKey = `${key}`;
      let fsm = this.fsmInstances.get(instanceKey);

      if (i === 0) {
        if (!fsm || fsm.currentEventIndex !== 0) {
          fsm = {
            key: instanceKey,
            currentEventIndex: 0,
            lastEventTime: log.timestamp,
            startTime: log.timestamp,
            matchedLogs: []
          };
          this.fsmInstances.set(instanceKey, fsm);
        }
        fsm.matchedLogs.push(log);
        fsm.lastEventTime = log.timestamp;
        fsm.currentEventIndex = 1;

        if (this.condition.events.length === 1) {
          if (now - (this.lastFireTime.get(key) || 0) >= this.cooldownMs) {
            this.lastFireTime.set(key, now);
            results.push({
              triggered: true,
              sequenceKey: key,
              matchedLogs: [...fsm.matchedLogs],
              eventId: event.eventId
            });
          }
          this.fsmInstances.delete(instanceKey);
        }
      } else if (fsm && fsm.currentEventIndex === i) {
        const prevEvent = this.condition.events[i - 1];
        const timeSincePrev = log.timestamp - fsm.lastEventTime;
        const totalTime = log.timestamp - fsm.startTime;

        if (timeSincePrev <= prevEvent.timeoutSeconds * 1000 &&
            totalTime <= this.condition.maxTotalSeconds * 1000) {
          fsm.matchedLogs.push(log);
          fsm.lastEventTime = log.timestamp;
          fsm.currentEventIndex = i + 1;

          if (fsm.currentEventIndex >= this.condition.events.length) {
            if (now - (this.lastFireTime.get(key) || 0) >= this.cooldownMs) {
              this.lastFireTime.set(key, now);
              results.push({
                triggered: true,
                sequenceKey: key,
                matchedLogs: [...fsm.matchedLogs],
                eventId: this.condition.events[this.condition.events.length - 1].eventId
              });
            }
            this.fsmInstances.delete(instanceKey);
          }
        } else {
          this.fsmInstances.delete(instanceKey);
          if (i === 0 || (fsm.currentEventIndex === i && timeSincePrev > prevEvent.timeoutSeconds * 1000)) {
            const newFsm: FSMState = {
              key: instanceKey,
              currentEventIndex: i === 0 ? 1 : 0,
              lastEventTime: log.timestamp,
              startTime: log.timestamp,
              matchedLogs: i === 0 ? [log] : []
            };
            if (i === 0) {
              this.fsmInstances.set(instanceKey, newFsm);
            }
          }
        }
      } else if (i === 0 && fsm) {
        continue;
      }
    }

    return results;
  }

  private extractKeyValue(log: StructuredLog): string | null {
    let fieldPath = this.condition.keyField;
    if (fieldPath.startsWith('fields.')) fieldPath = fieldPath.substring(7);
    const parts = fieldPath.split('.');
    let current: any = log.fields;
    for (const part of parts) {
      if (current === null || current === undefined) return null;
      current = current[part];
    }
    if (current === null || current === undefined || current === '') return null;
    return String(current);
  }

  private cleanupExpiredInstances(now: number): void {
    const maxAge = this.condition.maxTotalSeconds * 1000 * 2;
    for (const [key, instance] of this.fsmInstances.entries()) {
      if (now - instance.lastEventTime > maxAge) {
        this.fsmInstances.delete(key);
      }
    }
  }

  getActiveInstances(): number {
    return this.fsmInstances.size;
  }

  reset(): void {
    this.fsmInstances.clear();
    this.lastFireTime.clear();
  }
}
