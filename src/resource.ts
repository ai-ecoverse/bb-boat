import { z } from "zod";

export const boatMachineResourceSchema = z.object({
  key: z.string().min(1),
  sandboxId: z.string().min(1),
  /** Boat account that owns the sandbox; lifecycle calls refuse another account's key. */
  accountId: z.string().min(1),
});
export type BoatMachineResource = z.infer<typeof boatMachineResourceSchema>;

export function readBoatMachineResource(value: unknown): BoatMachineResource {
  return boatMachineResourceSchema.parse(value);
}
