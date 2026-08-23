/**
 * Proves the bounded SW-2 boot seam against the production runtime without
 * deterministic/test runtimes or false production-repository claims.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringToUuid } from "@elizaos/core";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../cloud/test-mocks/src/synthetic-environment";
import {
  bootProductionSyntheticController,
  SqliteSyntheticCommandJournal,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "../src";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "eliza-sw2-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production synthetic controller", () => {
  test("boots production, preserves active journal ownership, and tears down", async () => {
    const root = tempDirectory();
    const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "authority.sqlite"),
    );
    const authority = (
      await leaseStore.acquire({
        namespace: "sw2-production",
        owner: { ownerId: "controller", processId: process.pid, host: "local" },
        leaseDurationMs: 30_000,
      })
    ).authority;
    const name = "SW2 Production Controller";
    const journal = new SqliteSyntheticCommandJournal(leaseStore);
    let releaseActiveCommand: (() => void) | undefined;
    const activeCommandReached = Promise.withResolvers<void>();
    const activeCommandRelease = new Promise<void>((resolve) => {
      releaseActiveCommand = resolve;
    });
    const activeExecution = journal.execute(
      authority,
      {
        version: SYNTHETIC_WORLD_COMMAND_VERSION,
        namespace: authority.namespace,
        generation: authority.generation,
        commandId: "already-active",
        type: "test.active",
        payload: null,
      },
      () => null,
      {
        onCheckpoint: async ({ phase }) => {
          if (phase !== "EXECUTING") return;
          activeCommandReached.resolve();
          await activeCommandRelease;
        },
      },
    );
    await activeCommandReached.promise;
    const controller = await bootProductionSyntheticController({
      authority,
      leaseStore,
      runtime: {
        agentName: name,
        workspaceDirectory: path.join(root, "workspace"),
        pgliteDataDirectory: path.join(root, "pglite"),
      },
    });

    expect(controller.snapshot()).toMatchObject({
      state: "available",
      namespace: authority.namespace,
      generation: authority.generation,
      agentId: stringToUuid(name),
      repositoryIdentity: {
        agentId: stringToUuid(name),
        name,
      },
      recovery: { activeCommandIds: ["already-active"] },
    });
    expect(
      await journal.inspect(
        authority,
        `production-runtime-boot-${authority.generation}`,
      ),
    ).toMatchObject({
      phase: "SUCCEEDED",
      outcome: "KNOWN_SUCCESS",
      payload: {
        agentName: name,
        workspaceDirectory: path.join(root, "workspace"),
        pgliteDataDirectory: path.join(root, "pglite"),
      },
      result: { attemptGranted: true },
    });
    expect(controller.capabilities).toEqual({
      available: [
        "lease-generation-fence",
        "durable-command-journal",
        "production-runtime-boot-grant",
        "production-runtime-controller",
        "production-repository-readback",
      ],
      unavailable: [
        "production-repository-transaction",
        "full-manifest",
        "virtual-clock",
        "fault-injection",
        "observation-ledger",
        "subprocess-orchestration",
        "cloud-command-journal-adapter",
        "production-deployment-qualification",
      ],
    });
    releaseActiveCommand?.();
    await activeExecution;

    await expect(
      bootProductionSyntheticController({
        authority,
        leaseStore,
        runtime: {
          agentName: "collision",
          workspaceDirectory: path.join(root, "collision-workspace"),
          pgliteDataDirectory: path.join(root, "collision-pglite"),
        },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_COLLISION" });

    await controller.teardown();
    expect(controller.snapshot().state).toBe("stopped");
    await expect(
      bootProductionSyntheticController({
        authority,
        leaseStore,
        runtime: {
          agentName: name,
          workspaceDirectory: path.join(root, "workspace"),
          pgliteDataDirectory: path.join(root, "pglite"),
        },
      }),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_CONTROLLER_BOOT_ALREADY_ATTEMPTED",
    });
    leaseStore.close();
  }, 120_000);

  test("consumes a durable boot grant when production boot fails", async () => {
    const root = tempDirectory();
    const blockedParent = path.join(root, "not-a-directory");
    writeFileSync(blockedParent, "blocked");
    const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "authority.sqlite"),
    );
    const authority = (
      await leaseStore.acquire({
        namespace: "sw2-boot-failure",
        owner: { ownerId: "controller", processId: process.pid, host: "local" },
        leaseDurationMs: 30_000,
      })
    ).authority;
    const runtime = {
      agentName: "Broken Production Boot",
      workspaceDirectory: path.join(root, "workspace"),
      pgliteDataDirectory: path.join(blockedParent, "pglite"),
    };

    await expect(
      bootProductionSyntheticController({ authority, leaseStore, runtime }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_BOOT_FAILED" });
    const journal = new SqliteSyntheticCommandJournal(leaseStore);
    expect(
      await journal.inspect(
        authority,
        `production-runtime-boot-${authority.generation}`,
      ),
    ).toMatchObject({
      phase: "SUCCEEDED",
      outcome: "KNOWN_SUCCESS",
      result: { attemptGranted: true },
    });
    await expect(
      bootProductionSyntheticController({ authority, leaseStore, runtime }),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_CONTROLLER_BOOT_ALREADY_ATTEMPTED",
    });
    await expect(
      bootProductionSyntheticController({
        authority,
        leaseStore,
        runtime: { ...runtime, agentName: "Changed Broken Production Boot" },
      }),
    ).rejects.toMatchObject({
      code: "SYNTHETIC_CONTROLLER_BOOT_CONFIG_CONFLICT",
    });
    leaseStore.close();
  }, 120_000);

  test("surfaces boot, process-owner, stale-generation, and expiry failures", async () => {
    const root = tempDirectory();
    const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "authority.sqlite"),
    );
    const authority = (
      await leaseStore.acquire({
        namespace: "sw2-failures",
        owner: { ownerId: "controller", processId: process.pid, host: "local" },
        leaseDurationMs: 30_000,
      })
    ).authority;
    await expect(
      bootProductionSyntheticController({
        authority: {
          ...authority,
          owner: { ...authority.owner, processId: process.pid + 1 },
        },
        leaseStore,
        runtime: {
          agentName: "foreign-owner",
          workspaceDirectory: path.join(root, "foreign-workspace"),
          pgliteDataDirectory: path.join(root, "foreign-pglite"),
        },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_COLLISION" });
    const aborted = new AbortController();
    aborted.abort(new Error("boot cancelled"));
    await expect(
      bootProductionSyntheticController({
        authority,
        leaseStore,
        abortSignal: aborted.signal,
        runtime: {
          agentName: "aborted",
          workspaceDirectory: path.join(root, "aborted-workspace"),
          pgliteDataDirectory: path.join(root, "aborted-pglite"),
        },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_BOOT_FAILED" });

    const name = "SW2 Failure Controller";
    const controller = await bootProductionSyntheticController({
      authority,
      leaseStore,
      runtime: {
        agentName: name,
        workspaceDirectory: path.join(root, "workspace"),
        pgliteDataDirectory: path.join(root, "pglite"),
      },
    });
    await controller.teardown();
    const next = await leaseStore.rollover({
      authority,
      leaseDurationMs: 30_000,
    });
    await expect(
      bootProductionSyntheticController({
        authority,
        leaseStore,
        runtime: {
          agentName: "stale",
          workspaceDirectory: path.join(root, "stale-workspace"),
          pgliteDataDirectory: path.join(root, "stale-pglite"),
        },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_BOOT_FAILED" });
    expect(next.authority.generation).toBe(authority.generation + 1);

    const expiringStore = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(root, "expiring.sqlite"),
    );
    const expiringAuthority = (
      await expiringStore.acquire({
        namespace: "sw2-expired",
        owner: { ownerId: "controller", processId: process.pid, host: "local" },
        leaseDurationMs: 10,
      })
    ).authority;
    await Bun.sleep(20);
    await expect(
      bootProductionSyntheticController({
        authority: expiringAuthority,
        leaseStore: expiringStore,
        runtime: {
          agentName: "expired",
          workspaceDirectory: path.join(root, "expired-workspace"),
          pgliteDataDirectory: path.join(root, "expired-pglite"),
        },
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_CONTROLLER_BOOT_FAILED" });
    expiringStore.close();
    leaseStore.close();
  }, 120_000);
});
