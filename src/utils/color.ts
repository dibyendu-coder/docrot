/**
 * Terminal styling utilities with NO_COLOR, FORCE_COLOR, and TTY support.
 */

export function areColorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") {
    return true;
  }
  return Boolean(process.stdout && process.stdout.isTTY);
}

function wrap(code: number, resetCode: number) {
  return (text: string): string => {
    if (!areColorsEnabled()) {
      return text;
    }
    return `\u001b[${code}m${text}\u001b[${resetCode}m`;
  };
}

export const colors = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};
