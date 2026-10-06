// Keep the launcher and compiled server on one policy implementation. The
// launcher is source-distributed and cannot import TypeScript directly.
// @ts-ignore -- scripts/git-promote-policy.mjs intentionally has no declaration file.
import * as policy from "../scripts/git-promote-policy.mjs";

export interface GitPromotePolicyRule {
  remote: string;
  endpoint: string;
  branches: string[];
}

export interface GitPromotePolicy {
  enabled: boolean;
  rules: GitPromotePolicyRule[];
}

export interface EffectivePromoteEndpointResult {
  ok: boolean;
  reason?: string;
  endpoint?: string;
  identity?: string;
  style?: string;
  endpoint_count?: number;
  endpoints?: string[];
}

export interface GitPromotePolicyDecision {
  allowed: boolean;
  reason?: string;
  remote?: string;
  branch?: string;
  endpoint?: string;
  rule?: GitPromotePolicyRule;
}

export function defaultGitPromotePolicy(): GitPromotePolicy {
  return policy.defaultGitPromotePolicy() as GitPromotePolicy;
}

export function normalizeGitPromotePolicy(value: unknown): GitPromotePolicy {
  return policy.normalizeGitPromotePolicy(value) as GitPromotePolicy;
}

export function parseGitPromotePolicy(value: unknown): GitPromotePolicy {
  return policy.parseGitPromotePolicy(value) as GitPromotePolicy;
}

export function serializeGitPromotePolicy(value: unknown): string {
  return policy.serializeGitPromotePolicy(value) as string;
}

export function sanitizeGitPromotePolicy(value: unknown): GitPromotePolicy {
  return policy.sanitizeGitPromotePolicy(value) as GitPromotePolicy;
}

export function summarizeGitPromotePolicy(value: unknown): {
  enabled: boolean;
  rule_count: number;
  branch_count: number;
} {
  return policy.summarizeGitPromotePolicy(value) as {
    enabled: boolean;
    rule_count: number;
    branch_count: number;
  };
}

export function inspectGitPromoteEndpoint(value: unknown): {
  ok: boolean;
  reason?: string;
  diagnostic?: string;
  identity?: string;
  style?: string;
} {
  return policy.inspectGitPromoteEndpoint(value) as {
    ok: boolean;
    reason?: string;
    diagnostic?: string;
    identity?: string;
    style?: string;
  };
}

export function resolveEffectivePromoteEndpoint(
  repoRoot: string,
  remote: string,
  options: { gitBin?: string; timeoutMs?: number } = {}
): EffectivePromoteEndpointResult {
  return policy.resolveEffectivePromoteEndpoint(repoRoot, remote, options) as EffectivePromoteEndpointResult;
}

export function evaluateGitPromotePolicy(
  repoRoot: string,
  value: unknown,
  remote: string,
  branch: string,
  options: { gitBin?: string; timeoutMs?: number } = {}
): GitPromotePolicyDecision {
  return policy.evaluateGitPromotePolicy(repoRoot, value, remote, branch, options) as GitPromotePolicyDecision;
}

export const resolveGitPromotePolicy = evaluateGitPromotePolicy;
export const isGitPromotePolicyAllowed = evaluateGitPromotePolicy;
