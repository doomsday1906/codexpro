// Keep the launcher and compiled server on one policy implementation. The
// launcher is source-distributed and cannot import TypeScript directly.
// @ts-ignore -- scripts/git-push-policy.mjs intentionally has no declaration file.
import * as policy from "../scripts/git-push-policy.mjs";

export interface GitPushPolicyRule {
  remote: string;
  endpoint: string;
  branches: string[];
}

export interface GitPushPolicy {
  enabled: boolean;
  rules: GitPushPolicyRule[];
}

export interface EffectivePushEndpointResult {
  ok: boolean;
  reason?: string;
  endpoint?: string;
  identity?: string;
  style?: string;
  endpoint_count?: number;
  endpoints?: string[];
}

export interface GitPushPolicyDecision {
  allowed: boolean;
  reason?: string;
  remote?: string;
  branch?: string;
  endpoint?: string;
  rule?: GitPushPolicyRule;
}

export function defaultGitPushPolicy(): GitPushPolicy {
  return policy.defaultGitPushPolicy() as GitPushPolicy;
}

export function normalizeGitPushPolicy(value: unknown): GitPushPolicy {
  return policy.normalizeGitPushPolicy(value) as GitPushPolicy;
}

export function parseGitPushPolicy(value: unknown): GitPushPolicy {
  return policy.parseGitPushPolicy(value) as GitPushPolicy;
}

export function serializeGitPushPolicy(value: unknown): string {
  return policy.serializeGitPushPolicy(value) as string;
}

export function sanitizeGitPushPolicy(value: unknown): GitPushPolicy {
  return policy.sanitizeGitPushPolicy(value) as GitPushPolicy;
}

export function summarizeGitPushPolicy(value: unknown): {
  enabled: boolean;
  rule_count: number;
  branch_count: number;
} {
  return policy.summarizeGitPushPolicy(value) as {
    enabled: boolean;
    rule_count: number;
    branch_count: number;
  };
}

export function inspectGitPushEndpoint(value: unknown): {
  ok: boolean;
  reason?: string;
  diagnostic?: string;
  identity?: string;
  style?: string;
} {
  return policy.inspectGitPushEndpoint(value) as {
    ok: boolean;
    reason?: string;
    diagnostic?: string;
    identity?: string;
    style?: string;
  };
}

export function resolveEffectivePushEndpoint(
  repoRoot: string,
  remote: string,
  options: { gitBin?: string; timeoutMs?: number } = {}
): EffectivePushEndpointResult {
  return policy.resolveEffectivePushEndpoint(repoRoot, remote, options) as EffectivePushEndpointResult;
}

export function evaluateGitPushPolicy(
  repoRoot: string,
  value: unknown,
  remote: string,
  branch: string,
  options: { gitBin?: string; timeoutMs?: number } = {}
): GitPushPolicyDecision {
  return policy.evaluateGitPushPolicy(repoRoot, value, remote, branch, options) as GitPushPolicyDecision;
}

export const resolveGitPushPolicy = evaluateGitPushPolicy;
export const isGitPushPolicyAllowed = evaluateGitPushPolicy;
