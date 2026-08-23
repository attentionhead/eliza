/**
 * Grants one SW-1-fenced boot attempt, starts the canonical production runtime
 * from explicit inputs, and verifies its identity through PGlite readback.
 * Production repository transactions remain unavailable.
 */

import type { Database } from "bun:sqlite";
import path from "node:path";
import type { Agent, UUID } from "@elizaos/core";
import { ElizaError } from "@elizaos/core/errors";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/shared/contracts/synthetic-environment-lease";
import { ActiveSyntheticControllerReservation } from "./controller-reservation";
import { SqliteSyntheticCommandJournal } from "./sqlite-command-journal";
import type { SyntheticCommandRecovery } from "./types";
import {
  SYNTHETIC_WORLD_CAPABILITIES,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "./types";

const PRODUCTION_HOST_SPECIFIER: string = "@elizaos/agent";

interface ProductionRuntime {
  agentId: UUID;
  getAgent(agentId: UUID): Promise<Agent | null>;
}

interface ProductionRuntimeHost {
  buildInitializedRuntime(input: {
    abortSignal?: AbortSignal;
    localAgentMode: boolean;
    config: {
      meta: { firstRunComplete: true };
      ui: { assistant: { name: string } };
      agents: { defaults: { workspace: string } };
      database: {
        provider: "pglite";
        pglite: { dataDir: string };
      };
      plugins: { allow: string[] };
      logging: { level: "error" };
    };
  }): Promise<ProductionRuntime>;
  shutdownRuntime(
    runtime: ProductionRuntime,
    context: string,
    options?: { fast?: boolean },
  ): Promise<void>;
}

export interface ProductionSyntheticRuntimeInput {
  agentName: string;
  workspaceDirectory: string;
  pgliteDataDirectory: string;
}

export interface BootProductionSyntheticControllerInput {
  authority: SyntheticEnvironmentLeaseAuthority;
  leaseStore: SyntheticEnvironmentLeaseStore<Database>;
  runtime: ProductionSyntheticRuntimeInput;
  abortSignal?: AbortSignal;
}

export interface ProductionSyntheticControllerSnapshot {
  state: "available" | "stopping" | "stopped" | "failed";
  namespace: string;
  generation: number;
  agentId: string;
  repositoryIdentity: { agentId: string; name: string };
  recovery: SyntheticCommandRecovery;
  failure: { code: string; message: string } | null;
}

function bootCommandId(generation: number): string {
  return `production-runtime-boot-${generation}`;
}

function controllerError(
  code: string,
  message: string,
  context?: Record<string, string | number>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
    context,
    cause,
  });
}

function validateRuntimeInput(input: ProductionSyntheticRuntimeInput): void {
  if (
    typeof input.agentName !== "string" ||
    input.agentName.trim() !== input.agentName ||
    input.agentName.length < 1 ||
    input.agentName.length > 128
  ) {
    throw controllerError(
      "SYNTHETIC_CONTROLLER_INVALID_INPUT",
      "runtime.agentName must be 1-128 trimmed characters",
    );
  }
  for (const [field, value] of [
    ["runtime.workspaceDirectory", input.workspaceDirectory],
    ["runtime.pgliteDataDirectory", input.pgliteDataDirectory],
  ] as const) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_INVALID_INPUT",
        `${field} must be an absolute path`,
      );
    }
  }
}

/** Public operations exposed by an available SW-2 production controller. */
export interface ProductionSyntheticController {
  readonly capabilities: typeof SYNTHETIC_WORLD_CAPABILITIES;
  snapshot(): ProductionSyntheticControllerSnapshot;
  teardown(): Promise<void>;
}

/** Owns one production runtime until deterministic teardown. */
class ProductionSyntheticControllerImpl
  implements ProductionSyntheticController
{
  readonly capabilities = SYNTHETIC_WORLD_CAPABILITIES;
  private state: ProductionSyntheticControllerSnapshot["state"] = "available";
  private failure: ProductionSyntheticControllerSnapshot["failure"] = null;

  constructor(
    private readonly authority: SyntheticEnvironmentLeaseAuthority,
    private readonly runtime: ProductionRuntime,
    private readonly repositoryIdentity: {
      agentId: string;
      name: string;
    },
    private readonly recovery: SyntheticCommandRecovery,
    private readonly reservation: ActiveSyntheticControllerReservation,
    private readonly stopRuntime: (runtime: ProductionRuntime) => Promise<void>,
  ) {}

  snapshot(): ProductionSyntheticControllerSnapshot {
    return {
      state: this.state,
      namespace: this.authority.namespace,
      generation: this.authority.generation,
      agentId: this.runtime.agentId,
      repositoryIdentity: this.repositoryIdentity,
      recovery: this.recovery,
      failure: this.failure,
    };
  }

  async teardown(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "stopping") {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_NOT_AVAILABLE",
        "Controller teardown is already in progress",
      );
    }
    this.state = "stopping";
    this.failure = null;
    try {
      await this.reservation.releaseAfterConfirmedCleanup(() =>
        this.stopRuntime(this.runtime),
      );
      this.state = "stopped";
    } catch (error) {
      // error-policy:J2 Teardown failure remains visible and retains ownership.
      this.state = "failed";
      this.failure = {
        code: "SYNTHETIC_CONTROLLER_TEARDOWN_FAILED",
        message:
          error instanceof Error ? error.message : "Runtime teardown failed",
      };
      throw controllerError(
        this.failure.code,
        this.failure.message,
        { namespace: this.authority.namespace },
        error,
      );
    }
  }
}

export async function bootProductionSyntheticController(
  input: BootProductionSyntheticControllerInput,
): Promise<ProductionSyntheticController> {
  validateRuntimeInput(input.runtime);
  if (
    input.authority.owner.processId !== null &&
    input.authority.owner.processId !== process.pid
  ) {
    throw controllerError(
      "SYNTHETIC_CONTROLLER_COLLISION",
      "The active lease belongs to a different process",
      {
        namespace: input.authority.namespace,
        generation: input.authority.generation,
        ownerProcessId: input.authority.owner.processId,
      },
    );
  }
  const reservation = ActiveSyntheticControllerReservation.acquire(
    input.authority,
  );

  let runtime: ProductionRuntime | null = null;
  let shutdown:
    | ((runtime: ProductionRuntime, context: string) => Promise<void>)
    | null = null;
  try {
    input.abortSignal?.throwIfAborted();
    const journal = new SqliteSyntheticCommandJournal(input.leaseStore);
    const grant = await journal.execute(
      input.authority,
      {
        version: SYNTHETIC_WORLD_COMMAND_VERSION,
        namespace: input.authority.namespace,
        generation: input.authority.generation,
        commandId: bootCommandId(input.authority.generation),
        type: "production-runtime.boot.grant",
        payload: {
          agentName: input.runtime.agentName,
          workspaceDirectory: input.runtime.workspaceDirectory,
          pgliteDataDirectory: input.runtime.pgliteDataDirectory,
        },
      },
      () => ({ attemptGranted: true }),
    );
    if (grant.replayed) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_BOOT_ALREADY_ATTEMPTED",
        "This namespace generation already consumed its production boot attempt",
        {
          namespace: input.authority.namespace,
          generation: input.authority.generation,
        },
      );
    }
    const productionHost = (await import(
      PRODUCTION_HOST_SPECIFIER
    )) as ProductionRuntimeHost;
    shutdown = productionHost.shutdownRuntime;
    runtime = await productionHost.buildInitializedRuntime({
      abortSignal: input.abortSignal,
      localAgentMode: true,
      config: {
        meta: { firstRunComplete: true },
        ui: { assistant: { name: input.runtime.agentName } },
        agents: {
          defaults: { workspace: input.runtime.workspaceDirectory },
        },
        database: {
          provider: "pglite",
          pglite: { dataDir: input.runtime.pgliteDataDirectory },
        },
        plugins: { allow: ["@elizaos/plugin-sql"] },
        logging: { level: "error" },
      },
    });
    const storedAgent = await runtime.getAgent(runtime.agentId);
    if (
      storedAgent === null ||
      storedAgent.id !== runtime.agentId ||
      storedAgent.name !== input.runtime.agentName
    ) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_REPOSITORY_READBACK_FAILED",
        "Production PGlite did not return the booted runtime identity",
        {
          namespace: input.authority.namespace,
          generation: input.authority.generation,
          agentId: runtime.agentId,
        },
      );
    }
    const repositoryIdentity = {
      agentId: storedAgent.id,
      name: storedAgent.name,
    };
    const recovery = await journal.recover(input.authority);
    return new ProductionSyntheticControllerImpl(
      input.authority,
      runtime,
      repositoryIdentity,
      recovery,
      reservation,
      async (ownedRuntime) => {
        await productionHost.shutdownRuntime(
          ownedRuntime,
          "synthetic production controller teardown",
          { fast: true },
        );
      },
    );
  } catch (error) {
    // error-policy:J2 Failed initialization tears down anything production boot created.
    if (runtime !== null && shutdown !== null) {
      const runtimeToShutdown = runtime;
      const shutdownRuntime = shutdown;
      try {
        await reservation.releaseAfterConfirmedCleanup(() =>
          shutdownRuntime(
            runtimeToShutdown,
            "synthetic production controller failed boot",
          ),
        );
      } catch (cleanupError) {
        throw controllerError(
          "SYNTHETIC_CONTROLLER_BOOT_CLEANUP_FAILED",
          "Production controller boot and cleanup both failed",
          { namespace: input.authority.namespace },
          new AggregateError([error, cleanupError]),
        );
      }
    } else {
      reservation.releaseWithoutRuntime();
    }
    if (
      error instanceof ElizaError &&
      error.code === "SYNTHETIC_CONTROLLER_BOOT_ALREADY_ATTEMPTED"
    ) {
      throw error;
    }
    if (
      error instanceof ElizaError &&
      error.code === "SYNTHETIC_COMMAND_ID_CONFLICT"
    ) {
      throw controllerError(
        "SYNTHETIC_CONTROLLER_BOOT_CONFIG_CONFLICT",
        "This namespace generation already bound its boot attempt to different production inputs",
        {
          namespace: input.authority.namespace,
          generation: input.authority.generation,
        },
        error,
      );
    }
    throw controllerError(
      "SYNTHETIC_CONTROLLER_BOOT_FAILED",
      error instanceof Error ? error.message : "Production runtime boot failed",
      { namespace: input.authority.namespace },
      error,
    );
  }
}
