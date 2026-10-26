import { validLimit } from "./budget.js";

export interface Grant {
  subject: string;
  operations: readonly string[];
  targets: readonly string[];
  provider?: string | undefined;
  expiresAt: string | null;
  limits: {
    maxCalls: number | null;
    maxTokens: number | null;
  };
}

export interface TypedHardRestrictions {
  readonly denyOperations?: readonly string[];
  readonly denyTargets?: readonly string[];
  readonly denyProviders?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly denyRealms?: readonly string[];
}

export interface TaskContract {
  taskId: string;
  rootId: string;
  revision: number;
  objective: string;
  scope: readonly string[];
  acceptanceCriteria: readonly string[];
  obligations: readonly string[];
  grants: readonly Grant[];
  prohibitions: readonly string[];
  // Optional typed hard restrictions (machine-enforceable deny rules
  // evaluated by the authority kernel). Free-text `prohibitions` stay
  // GUIDANCE: rendered to the model, never hard enforcement.
  restrictions?: TypedHardRestrictions | undefined;
  // Opt-in human confirmation for mutating tools (edit, exec, process
  // spawn/stdin/stop), enforced at admission (runtime/approval.ts).
  approvalPolicy?: "none" | "confirm-mutations" | undefined;
  realm: string;
  allowedProvider: string | null;
  allowedModel: string | null;
  expiresAt: string | null;
  retentionPolicy: string;
  origin: string;
}

export type ContractInput = Omit<TaskContract, "revision"> & { revision?: number | undefined };

function nonEmpty(value: string): boolean {
  return value.trim() !== "";
}

function validDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function validateContract(contract: ContractInput): string[] {
  const errors: string[] = [];
  if (!nonEmpty(contract.taskId)) errors.push("taskId must be non-empty");
  if (!nonEmpty(contract.rootId)) errors.push("rootId must be non-empty");
  if (!nonEmpty(contract.objective)) errors.push("objective must be non-empty");
  if (contract.scope.length === 0) errors.push("scope must list at least one entry");
  if (contract.acceptanceCriteria.length === 0) {
    errors.push("acceptanceCriteria must list at least one criterion");
  }
  if (contract.obligations.length === 0) errors.push("obligations must list at least one entry");
  if (!nonEmpty(contract.realm)) errors.push("realm must be non-empty");
  if (contract.expiresAt !== null && !validDate(contract.expiresAt)) errors.push("expiresAt must be null or a valid timestamp");
  if (!nonEmpty(contract.retentionPolicy)) errors.push("retentionPolicy must be non-empty");
  if (!nonEmpty(contract.origin)) errors.push("origin must record the source of each decision");
  if (contract.revision !== undefined && (!Number.isInteger(contract.revision) || contract.revision < 1)) {
    errors.push("revision must be a positive integer");
  }
  for (const [index, grant] of contract.grants.entries()) {
    if (!nonEmpty(grant.subject)) errors.push(`grants[${index}].subject must be non-empty`);
    if (grant.operations.length === 0) errors.push(`grants[${index}].operations must not be empty`);
    if (grant.expiresAt !== null && !validDate(grant.expiresAt)) {
      errors.push(`grants[${index}].expiresAt must be null or a valid timestamp`);
    }
    if (!validLimit(grant.limits.maxCalls)) {
      errors.push(`grants[${index}].limits.maxCalls must be a positive integer`);
    }
    if (!validLimit(grant.limits.maxTokens)) {
      errors.push(`grants[${index}].limits.maxTokens must be a positive integer`);
    }
  }
  return errors;
}

export function createContract(input: Omit<ContractInput, "revision">): TaskContract {
  const contract: TaskContract = { ...input, revision: 1 };
  const errors = validateContract(contract);
  if (errors.length > 0) {
    throw new Error(`Invalid task contract: ${errors.join("; ")}`);
  }
  return contract;
}

export function reviseContract(
  contract: TaskContract,
  change: Partial<Omit<TaskContract, "taskId" | "rootId" | "revision">> & { origin: string },
): TaskContract {
  const revised: TaskContract = { ...contract, ...change, revision: contract.revision + 1 };
  const errors = validateContract(revised);
  if (errors.length > 0) {
    throw new Error(`Invalid contract revision: ${errors.join("; ")}`);
  }
  return revised;
}

export function isContractExpired(contract: TaskContract, now: Date = new Date()): boolean {
  return contract.expiresAt !== null && Date.parse(contract.expiresAt) <= now.getTime();
}

export function findGrant(contract: TaskContract, operation: string, now: Date = new Date()): Grant | null {
  if (isContractExpired(contract, now)) return null;
  for (const grant of contract.grants) {
    if (!grant.operations.includes(operation)) continue;
    if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now.getTime()) continue;
    return grant;
  }
  return null;
}
