import { z } from 'zod';

export const emptyInputSchema = z.object({}).strict();

export const serialLogInputSchema = z
  .object({
    maxLines: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .optional()
      .describe('Number of most recent raw MCU serial lines to return.'),
  })
  .strict();

export const sendSerialInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(65_536)
      .describe('Text to send through the currently connected Workbench serial port.'),
    lineEnding: z
      .enum(['none', 'lf', 'cr', 'crlf'])
      .optional()
      .describe('Optional line ending appended to text. Defaults to none.'),
  })
  .strict();

export const waitSerialInputSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .max(1_024)
      .describe('Literal text pattern to wait for in the current raw serial stream.'),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe('Wait timeout in milliseconds. Defaults to 5000 and is capped at 60000.'),
  })
  .strict();
