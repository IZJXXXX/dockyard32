export type SupportedStm32Family = 'STM32F1' | 'STM32F4' | 'STM32G4';

export interface Stm32DeviceProfile {
  readonly family: SupportedStm32Family;
  readonly device: string;
  readonly cortex: 'Cortex-M3' | 'Cortex-M4';
  readonly gccCpu: 'cortex-m3' | 'cortex-m4';
  readonly fpu?: 'fpv4-sp-d16';
  readonly floatAbi?: 'hard';
  readonly defaultFlashBytes: number;
  readonly defaultRamBytes: number;
  readonly defaultCcmRamBytes: number;
}

const FLASH_BYTES_BY_CODE: Readonly<Record<string, number>> = {
  '4': 16 * 1024,
  '6': 32 * 1024,
  '8': 64 * 1024,
  B: 128 * 1024,
  C: 256 * 1024,
  D: 384 * 1024,
  E: 512 * 1024,
  F: 768 * 1024,
  G: 1024 * 1024,
  H: 1536 * 1024,
  I: 2048 * 1024,
};

export function stm32DeviceProfile(device: string | undefined): Stm32DeviceProfile {
  if (device === undefined || device.trim().length === 0) {
    throw new Error('STM32 MCU is required');
  }
  const normalized = normalizeStm32Device(device);
  const family = stm32Family(normalized);
  if (family === undefined) {
    throw new Error(`Unsupported or unrecognized STM32 MCU: ${device}`);
  }
  const flashCode = /^STM32(?:F|G)\d{3}[A-Z]([0-9A-Z])/u.exec(normalized)?.[1];
  const flash = flashCode === undefined ? undefined : FLASH_BYTES_BY_CODE[flashCode];
  const ram = fallbackRam(normalized, family, flashCode);
  const ccm = fallbackCcmRam(normalized, family);
  return {
    family,
    device: normalized,
    cortex: family === 'STM32F1' ? 'Cortex-M3' : 'Cortex-M4',
    gccCpu: family === 'STM32F1' ? 'cortex-m3' : 'cortex-m4',
    fpu: family === 'STM32F1' ? undefined : 'fpv4-sp-d16',
    floatAbi: family === 'STM32F1' ? undefined : 'hard',
    defaultFlashBytes: flash ?? defaultFlash(family),
    defaultRamBytes: ram,
    defaultCcmRamBytes: ccm,
  };
}

export function stm32Family(device: string): SupportedStm32Family | undefined {
  const match = /^STM32(F1|F4|G4)/iu.exec(device);
  return match?.[1] === undefined
    ? undefined
    : `STM32${match[1].toUpperCase()}` as SupportedStm32Family;
}

export function normalizeStm32Device(value: string): string {
  const upper = value.trim().toUpperCase();
  if (/^STM32(?:F|G)\d{3}[A-Z][0-9A-Z]TX$/u.test(upper)) {
    return `${upper.slice(0, -1)}x`;
  }
  if (/^STM32(?:F|G)\d{3}[A-Z][0-9A-Z]T\d$/u.test(upper)) {
    return `${upper.slice(0, -1)}x`;
  }
  if (/^STM32(?:F|G)\d{3}[A-Z][0-9A-Z]T$/u.test(upper)) {
    return `${upper}x`;
  }
  return upper;
}

export function gccArchitectureFlags(profile: Stm32DeviceProfile): string[] {
  const result = [`-mcpu=${profile.gccCpu}`, '-mthumb'];
  if (profile.fpu !== undefined && profile.floatAbi !== undefined) {
    result.push(`-mfpu=${profile.fpu}`, `-mfloat-abi=${profile.floatAbi}`);
  }
  return result;
}

export function keilArchitectureFlags(profile: Stm32DeviceProfile): string[] {
  const result = [`-mcpu=${profile.gccCpu}`];
  if (profile.fpu !== undefined && profile.floatAbi !== undefined) {
    result.push(`-mfpu=${profile.fpu}`, `-mfloat-abi=${profile.floatAbi}`);
  }
  return result;
}

function defaultFlash(family: SupportedStm32Family): number {
  return family === 'STM32F1' ? 128 * 1024 : family === 'STM32G4' ? 512 * 1024 : 1024 * 1024;
}

function fallbackRam(device: string, family: SupportedStm32Family, flashCode?: string): number {
  const model = /^STM32((?:F|G)\d{3})/u.exec(device)?.[1] ?? '';
  if (family === 'STM32F1') {
    if (model === 'F105' || model === 'F107') return 64 * 1024;
    if (model === 'F103') {
      if (flashCode === 'F' || flashCode === 'G') return 96 * 1024;
      if (flashCode === 'D' || flashCode === 'E') return 64 * 1024;
      if (flashCode === 'C') return 48 * 1024;
      return 20 * 1024;
    }
    if (model === 'F101') {
      if (flashCode === 'F' || flashCode === 'G') return 80 * 1024;
      if (flashCode === 'C' || flashCode === 'D' || flashCode === 'E') return 48 * 1024;
      return 16 * 1024;
    }
    return flashCode === '4' || flashCode === '6' ? 4 * 1024 : 8 * 1024;
  }
  if (family === 'STM32G4') {
    if (/^STM32G4(?:31|41)/u.test(device)) return 32 * 1024;
    if (/^STM32G4(?:91|A1)/u.test(device)) return 96 * 1024;
    return 128 * 1024;
  }
  if (/^STM32F410/u.test(device)) return 32 * 1024;
  if (/^STM32F40(?:1|2)/u.test(device)) return 64 * 1024;
  if (/^STM32F411/u.test(device)) return 128 * 1024;
  if (/^STM32F4(?:12|13|23)/u.test(device)) return 256 * 1024;
  if (/^STM32F4(?:27|29|37|39)/u.test(device)) return 192 * 1024;
  if (/^STM32F4(?:69|79)/u.test(device)) return 320 * 1024;
  return 128 * 1024;
}

function fallbackCcmRam(device: string, family: SupportedStm32Family): number {
  if (family === 'STM32F1') return 0;
  if (family === 'STM32G4') {
    return /^STM32G4(?:73|74|83|84)/u.test(device) ? 32 * 1024 :
      /^STM32G4(?:91|A1)/u.test(device) ? 16 * 1024 : 0;
  }
  return /^STM32F4(?:05|07|15|17|27|29|37|39|46|69|79)/u.test(device) ? 64 * 1024 : 0;
}
