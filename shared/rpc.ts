import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PolishEngineKindSchema, PolishProfileSchema } from "./preferences";

export const PolishRunInputSchema = z.object({
  text: z.string(),
  profileOverride: PolishProfileSchema.optional(),
});
export type PolishRunInput = z.infer<typeof PolishRunInputSchema>;

export const PolishRunOutputSchema = z.object({
  text: z.string(),
  changed: z.boolean(),
  fallback: z.boolean(),
  fallbackReason: z.string().optional(),
  latencyMs: z.number(),
  engine: PolishEngineKindSchema,
});
export type PolishRunOutput = z.infer<typeof PolishRunOutputSchema>;

export const polishRunRpc = defineRpc({
  name: "polish.run",
  input: PolishRunInputSchema,
  output: PolishRunOutputSchema,
});

export const PolishStatusInputSchema = z.object({});
export type PolishStatusInput = z.infer<typeof PolishStatusInputSchema>;

export const PolishStatusOutputSchema = z.object({
  engine: PolishEngineKindSchema,
  lastLatencyMs: z.number().nullable(),
  lastFallbackReason: z.string().nullable(),
  showComposerPill: z.boolean(),
});
export type PolishStatusOutput = z.infer<typeof PolishStatusOutputSchema>;

export const polishStatusRpc = defineRpc({
  name: "polish.status",
  input: PolishStatusInputSchema,
  output: PolishStatusOutputSchema,
});
