const PERCENT_PATTERN = /(?:\[\s*)?(\d{1,3}(?:\.\d+)?)\s*%(?:\s*\])?/u;
const FRACTION_PATTERN = /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/u;
const VERIFY_PATTERN = /\b(?:verif(?:y|ying|ication|ied)|checksum)\b/iu;

export interface ProgrammerProgress {
  readonly stage: 'flashing' | 'verifying';
  readonly percent: number;
}

export function parseCommandProgress(text: string): number | undefined {
  let latest: number | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const fraction = FRACTION_PATTERN.exec(line);
    if (fraction !== null) {
      const completed = Number.parseInt(fraction[1] ?? '', 10);
      const total = Number.parseInt(fraction[2] ?? '', 10);
      if (Number.isFinite(completed) && total > 0) {
        latest = clampPercent((completed / total) * 100);
      }
      continue;
    }

    const percent = PERCENT_PATTERN.exec(line);
    if (percent !== null) {
      const value = Number.parseFloat(percent[1] ?? '');
      if (Number.isFinite(value)) {
        latest = clampPercent(value);
      }
    }
  }
  return latest;
}

export function programmerProgressFromOutput(
  text: string,
  verifyEnabled: boolean,
): ProgrammerProgress | undefined {
  const rawPercent = parseCommandProgress(text);
  const verifying = verifyEnabled && VERIFY_PATTERN.test(text);
  if (verifying) {
    return {
      stage: 'verifying',
      percent: rawPercent === undefined
        ? 88
        : clampPercent(80 + rawPercent * 0.18),
    };
  }
  if (rawPercent === undefined) {
    return undefined;
  }
  return {
    stage: 'flashing',
    percent: clampPercent(30 + rawPercent * 0.48),
  };
}

export function scaleProgress(
  percent: number,
  start: number,
  span: number,
): number {
  return clampPercent(start + clampPercent(percent) * span / 100);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
