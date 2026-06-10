import { Silence, SilenceMatchers, CreateSilenceRequest, TriggeredAlert, AlertRule } from '../types';
import { v4 as uuidv4 } from 'uuid';
import CronExpressionParser from 'cron-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as chokidar from 'chokidar';

export interface SilenceManagerOptions {
  onSilencesReloaded?: (silences: Silence[]) => void;
}

interface RawSilence {
  id?: string;
  starts_at?: string | number;
  ends_at?: string | number;
  duration_seconds?: number;
  cron_expression?: string;
  matchers: {
    rule_ids?: string[];
    labels?: Record<string, string>;
  };
  created_by?: string;
  comment?: string;
}

export class SilenceManager {
  private silences: Map<string, Silence> = new Map();
  private silenceFiles: string[] = [];
  private watchers: chokidar.FSWatcher[] = [];
  private isReloading: boolean = false;
  private options: SilenceManagerOptions;

  constructor(options: SilenceManagerOptions = {}) {
    this.options = options;
  }

  async loadSilenceFiles(filePaths: string[]): Promise<Silence[]> {
    this.silenceFiles = filePaths;
    const allSilences: Silence[] = [];

    for (const filePath of filePaths) {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[SilenceManager] Silence file not found: ${resolvedPath}`);
        continue;
      }

      const silences = await this.loadFromFile(resolvedPath);
      allSilences.push(...silences);
    }

    for (const silence of allSilences) {
      this.silences.set(silence.id, silence);
    }

    this.setupFileWatchers(filePaths);
    console.info(`[SilenceManager] Loaded ${allSilences.length} silences from ${filePaths.length} files`);

    return allSilences;
  }

  private async loadFromFile(filePath: string): Promise<Silence[]> {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = yaml.load(content);

    let rawSilences: RawSilence[] = [];
    if (Array.isArray(parsed)) {
      rawSilences = parsed as RawSilence[];
    } else if (parsed && typeof parsed === 'object') {
      if ((parsed as any).silences && Array.isArray((parsed as any).silences)) {
        rawSilences = (parsed as any).silences as RawSilence[];
      } else {
        rawSilences = [parsed as RawSilence];
      }
    }

    return rawSilences.map(r => this.convertSilence(r));
  }

  private convertSilence(raw: RawSilence): Silence {
    const now = Date.now();
    let startsAt: number;
    let endsAt: number;

    if (raw.duration_seconds !== undefined) {
      startsAt = raw.starts_at ? this.parseTime(raw.starts_at) : now;
      endsAt = startsAt + raw.duration_seconds * 1000;
    } else {
      startsAt = raw.starts_at ? this.parseTime(raw.starts_at) : now;
      endsAt = raw.ends_at ? this.parseTime(raw.ends_at) : now + 3600 * 1000;
    }

    return {
      id: raw.id || uuidv4(),
      startsAt,
      endsAt,
      cronExpression: raw.cron_expression,
      matchers: {
        ruleIds: raw.matchers?.rule_ids,
        labels: raw.matchers?.labels
      },
      createdBy: raw.created_by || 'system',
      comment: raw.comment || '',
      createdAt: now,
      updatedAt: now
    };
  }

  private parseTime(value: string | number): number {
    if (typeof value === 'number') {
      return value;
    }
    const parsed = Date.parse(value);
    if (isNaN(parsed)) {
      throw new Error(`Invalid time format: ${value}`);
    }
    return parsed;
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
      console.info(`[SilenceManager] Silences changed, reloading...`);

      const fileSilenceIds = new Set<string>();
      for (const filePath of this.silenceFiles) {
        const resolvedPath = path.resolve(filePath);
        if (!fs.existsSync(resolvedPath)) continue;

        try {
          const silences = await this.loadFromFile(resolvedPath);
          for (const silence of silences) {
            fileSilenceIds.add(silence.id);
            this.silences.set(silence.id, silence);
          }
        } catch (e) {
          console.error(`[SilenceManager] Error reloading ${filePath}:`, e);
        }
      }

      console.info(`[SilenceManager] Loaded ${this.silences.size} silences`);

      if (this.options.onSilencesReloaded) {
        this.options.onSilencesReloaded(this.getAllSilences());
      }
    } catch (e) {
      console.error('[SilenceManager] Error reloading silences:', e);
    } finally {
      this.isReloading = false;
    }
  }

  createSilence(request: CreateSilenceRequest): Silence {
    const now = Date.now();
    const id = uuidv4();

    let startsAt: number;
    let endsAt: number;

    if (request.durationSeconds !== undefined) {
      startsAt = request.startsAt || now;
      endsAt = startsAt + request.durationSeconds * 1000;
    } else {
      startsAt = request.startsAt || now;
      endsAt = request.endsAt || now + 3600 * 1000;
    }

    const silence: Silence = {
      id,
      startsAt,
      endsAt,
      cronExpression: request.cronExpression,
      matchers: request.matchers,
      createdBy: request.createdBy || 'api',
      comment: request.comment || '',
      createdAt: now,
      updatedAt: now
    };

    this.silences.set(id, silence);
    console.info(`[SilenceManager] Created silence ${id} by ${silence.createdBy}`);
    return silence;
  }

  deleteSilence(id: string): boolean {
    const deleted = this.silences.delete(id);
    if (deleted) {
      console.info(`[SilenceManager] Deleted silence ${id}`);
    }
    return deleted;
  }

  extendSilence(id: string, durationSeconds: number): Silence | null {
    const silence = this.silences.get(id);
    if (!silence) return null;

    const now = Date.now();
    silence.endsAt = Math.max(silence.endsAt, now) + durationSeconds * 1000;
    silence.updatedAt = now;
    this.silences.set(id, silence);

    console.info(`[SilenceManager] Extended silence ${id} by ${durationSeconds}s`);
    return silence;
  }

  getSilence(id: string): Silence | undefined {
    return this.silences.get(id);
  }

  getAllSilences(includeExpired: boolean = true): Silence[] {
    const all = Array.from(this.silences.values());
    if (includeExpired) {
      return all.sort((a, b) => b.createdAt - a.createdAt);
    }
    return all.filter(s => this.isActive(s)).sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveSilences(now: number = Date.now()): Silence[] {
    return Array.from(this.silences.values()).filter(s => this.isActive(s, now));
  }

  isActive(silence: Silence, now: number = Date.now()): boolean {
    if (silence.cronExpression) {
      try {
        return this.isWithinCronWindow(silence, now);
      } catch (e) {
        console.warn(`[SilenceManager] Invalid cron expression in silence ${silence.id}:`, e);
        return now >= silence.startsAt && now <= silence.endsAt;
      }
    }
    return now >= silence.startsAt && now <= silence.endsAt;
  }

  private isWithinCronWindow(silence: Silence, now: number): boolean {
    if (now < silence.startsAt || now > silence.endsAt) {
      return false;
    }

    const cron = silence.cronExpression!;
    const expression = CronExpressionParser.parse(cron, {
      currentDate: new Date(now),
      tz: 'UTC'
    });

    const prevTime = expression.prev().getTime();
    const nowDate = new Date(now);

    const cronParts = cron.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      return now >= silence.startsAt && now <= silence.endsAt;
    }

    if (cronParts.length === 5 || cronParts.length === 6) {
      const isSixField = cronParts.length === 6;
      const minuteExpr = cronParts[isSixField ? 1 : 0];
      const hourExpr = cronParts[isSixField ? 2 : 1];
      const dayOfMonthExpr = cronParts[isSixField ? 3 : 2];
      const monthExpr = cronParts[isSixField ? 4 : 3];
      const dayOfWeekExpr = cronParts[isSixField ? 5 : 4];

      if (hourExpr !== '*' && !hourExpr.includes(',') && !hourExpr.includes('-') && !hourExpr.includes('/')) {
        const cronHour = parseInt(hourExpr, 10);
        if (!isNaN(cronHour)) {
          const currentHour = nowDate.getUTCHours();
          if (minuteExpr !== '*' && !minuteExpr.includes(',') && !minuteExpr.includes('-') && !minuteExpr.includes('/')) {
            const cronMinute = parseInt(minuteExpr, 10);
            if (!isNaN(cronMinute)) {
              const currentMinute = nowDate.getUTCMinutes();
              const currentTimeMinutes = currentHour * 60 + currentMinute;
              const cronTimeMinutes = cronHour * 60 + cronMinute;
              const diff = Math.abs(currentTimeMinutes - cronTimeMinutes);
              const windowMinutes = 120;
              if (diff <= windowMinutes) {
                return true;
              }
              if (24 * 60 - diff <= windowMinutes) {
                return true;
              }
              return false;
            }
          }
          const diffHours = Math.abs(currentHour - cronHour);
          if (diffHours <= 2 || 24 - diffHours <= 2) {
            return true;
          }
          return false;
        }
      }
    }

    const effectiveWindow = 2 * 60 * 60 * 1000;
    const timeSincePrev = now - prevTime;
    return timeSincePrev <= effectiveWindow;
  }

  private matchersMatch(silence: Silence, ruleId: string, labels?: Record<string, string>): boolean {
    const { matchers } = silence;
    let ruleIdMatch = true;
    let labelsMatch = true;

    if (matchers.ruleIds && matchers.ruleIds.length > 0) {
      ruleIdMatch = matchers.ruleIds.some(pattern => {
        if (pattern.includes('*') || pattern.includes('+')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\+/g, '.+') + '$');
          return regex.test(ruleId);
        }
        return pattern === ruleId;
      });
    }

    if (matchers.labels && Object.keys(matchers.labels).length > 0) {
      const checkLabels = labels || {};
      labelsMatch = Object.entries(matchers.labels).every(([key, pattern]) => {
        const value = checkLabels[key];
        if (value === undefined) return false;

        if (pattern.includes('*') || pattern.includes('+') || pattern.startsWith('/')) {
          let regexPattern = pattern;
          if (pattern.startsWith('/') && pattern.endsWith('/')) {
            regexPattern = pattern.slice(1, -1);
          } else {
            regexPattern = '^' + pattern.replace(/\*/g, '.*').replace(/\+/g, '.+') + '$';
          }
          try {
            const regex = new RegExp(regexPattern);
            return regex.test(String(value));
          } catch {
            return false;
          }
        }
        return String(value) === pattern;
      });
    }

    return ruleIdMatch && labelsMatch;
  }

  checkSilenced(alert: TriggeredAlert, rule?: AlertRule, now: number = Date.now()): Silence | null {
    const labels: Record<string, string> = {};

    if (alert.logs && alert.logs.length > 0) {
      const fields = alert.logs[0].fields || {};
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          labels[key] = String(value);
        }
      }
    }

    if (alert.groupKey) labels['groupKey'] = alert.groupKey;
    if (alert.sequenceKey) labels['sequenceKey'] = alert.sequenceKey;
    labels['severity'] = alert.severity;

    const activeSilences = this.getActiveSilences(now);
    for (const silence of activeSilences) {
      if (this.matchersMatch(silence, alert.ruleId, labels)) {
        return silence;
      }
    }

    return null;
  }

  getMatchingSilences(ruleId: string, labels?: Record<string, string>, now: number = Date.now()): Silence[] {
    const activeSilences = this.getActiveSilences(now);
    return activeSilences.filter(s => this.matchersMatch(s, ruleId, labels));
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
}
