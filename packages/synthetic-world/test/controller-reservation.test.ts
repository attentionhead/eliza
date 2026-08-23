/**
 * Proves the production controller reservation remains held after ambiguous
 * cleanup and is released only after confirmed cleanup.
 */

import { describe, expect, test } from "bun:test";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { ActiveSyntheticControllerReservation } from "../src/controller-reservation";

function authority(namespace: string): SyntheticEnvironmentLeaseAuthority {
  return {
    version: 1,
    namespace,
    generation: 1,
    leaseId: "lease",
    owner: { ownerId: "owner", processId: process.pid, host: "local" },
  };
}

describe("ActiveSyntheticControllerReservation", () => {
  test("retains ownership when cleanup fails and releases after a confirmed retry", async () => {
    const input = authority("cleanup-failure");
    const reservation = ActiveSyntheticControllerReservation.acquire(input);

    await expect(
      reservation.releaseAfterConfirmedCleanup(async () => {
        throw new Error("shutdown ambiguous");
      }),
    ).rejects.toThrow("shutdown ambiguous");
    expect(() => ActiveSyntheticControllerReservation.acquire(input)).toThrow(
      "already owns",
    );

    await reservation.releaseAfterConfirmedCleanup(async () => {});
    const replacement = ActiveSyntheticControllerReservation.acquire(input);
    replacement.releaseWithoutRuntime();
  });
});
