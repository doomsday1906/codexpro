import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface BuildIdentityFile {
  readonly schema_version: 1;
  readonly package_name: string;
  readonly package_version: string;
  readonly source_commit: string | null;
  readonly source_state: "clean" | "dirty" | "unavailable";
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
export const CODEXPRO_PACKAGE_ROOT = realpathSync(path.resolve(moduleDirectory, ".."));

let identity: BuildIdentityFile | null = null;
try {
  const parsed: unknown = JSON.parse(readFileSync(path.join(moduleDirectory, "build-identity.json"), "utf8"));
  if (parsed && typeof parsed === "object") {
    const candidate = parsed as Partial<BuildIdentityFile>;
    if (candidate.schema_version === 1
      && typeof candidate.package_name === "string"
      && typeof candidate.package_version === "string"
      && (candidate.source_commit === null || (typeof candidate.source_commit === "string" && /^[0-9a-f]{40}$/u.test(candidate.source_commit)))
      && ["clean", "dirty", "unavailable"].includes(String(candidate.source_state))) {
      identity = candidate as BuildIdentityFile;
    }
  }
} catch {
  identity = null;
}

export const CODEXPRO_BUILD_IDENTITY = identity ?? {
  schema_version: 1 as const,
  package_name: "codexpro",
  package_version: "unknown",
  source_commit: null,
  source_state: "unavailable" as const
};
