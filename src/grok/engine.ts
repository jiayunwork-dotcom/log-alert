import { DEFAULT_GROK_PATTERNS } from './patterns';

export interface GrokMatch {
  [key: string]: string;
}

export interface CompiledGrok {
  regex: RegExp;
  fieldNames: string[];
  patternName?: string;
}

const GROK_PATTERN_RE = /%\{([A-Z0-9_]+)(?::([a-zA-Z0-9_]+))?(?::([a-zA-Z]+))?\}/g;

function resolvePattern(
  name: string,
  patterns: Record<string, string>,
  resolved: Set<string> = new Set()
): string {
  if (resolved.has(name)) {
    return patterns[name] || '';
  }
  resolved.add(name);
  const raw = patterns[name];
  if (!raw) return '';

  return raw.replace(GROK_PATTERN_RE, (_match, innerName, _fieldName, _type) => {
    return '(?:' + resolvePattern(innerName, patterns, resolved) + ')';
  });
}

export function compileGrokPattern(
  pattern: string,
  customPatterns: Record<string, string> = {}
): CompiledGrok {
  const mergedPatterns = { ...DEFAULT_GROK_PATTERNS, ...customPatterns };
  const fieldNames: string[] = [];

  let processed = pattern;
  let fieldIndex = 0;

  const namedGroups = new Map<string, number>();

  processed = pattern.replace(GROK_PATTERN_RE, (match, patternName, fieldName, _type) => {
    const resolved = resolvePattern(patternName, mergedPatterns);
    if (fieldName) {
      fieldIndex++;
      fieldNames.push(fieldName);
      namedGroups.set(fieldName, fieldIndex);
      return `(${resolved})`;
    } else {
      return `(?:${resolved})`;
    }
  });

  try {
    const regex = new RegExp(`^${processed}$`);
    return { regex, fieldNames, patternName: pattern };
  } catch (e) {
    throw new Error(`Failed to compile grok pattern: ${pattern}. Error: ${e}`);
  }
}

export function compileRegexPattern(pattern: string): CompiledGrok {
  try {
    const fieldNames: string[] = [];

    const namedGroupRe = /\(\?P<([a-zA-Z_][a-zA-Z0-9_]*)>/g;
    const converted = pattern.replace(namedGroupRe, (_fullMatch, name) => {
      fieldNames.push(name);
      return `(?<${name}>`;
    });

    const regex = new RegExp(converted);
    return { regex, fieldNames };
  } catch (e) {
    throw new Error(`Failed to compile regex pattern: ${pattern}. Error: ${e}`);
  }
}

export function matchGrok(
  line: string,
  compiled: CompiledGrok
): GrokMatch | null {
  const match = line.match(compiled.regex);
  if (!match) return null;

  const result: GrokMatch = {};
  compiled.fieldNames.forEach((name, idx) => {
    if (match[idx + 1] !== undefined) {
      result[name] = match[idx + 1];
    }
  });

  return result;
}

export function testGrokMatchRate(
  compiled: CompiledGrok,
  lines: string[]
): { rate: number; matched: number; total: number; sampleMatches: Array<{ line: string; match: GrokMatch }> } {
  let matched = 0;
  const sampleMatches: Array<{ line: string; match: GrokMatch }> = [];
  const total = lines.length;

  for (const line of lines) {
    const m = matchGrok(line, compiled);
    if (m) {
      matched++;
      if (sampleMatches.length < 3) {
        sampleMatches.push({ line, match: m });
      }
    }
  }

  return {
    rate: total > 0 ? matched / total : 0,
    matched,
    total,
    sampleMatches
  };
}
