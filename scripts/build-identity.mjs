export function createBuildIdentity({ packageName, packageVersion, sourceCommit, sourceState }) {
  const commit = typeof sourceCommit === "string" && /^[0-9a-f]{40}$/u.test(sourceCommit) ? sourceCommit : null;
  const state = !commit || !["clean", "dirty"].includes(sourceState) ? "unavailable" : sourceState;
  return {
    schema_version: 1,
    package_name: String(packageName || "codexpro"),
    package_version: String(packageVersion || "unknown"),
    source_commit: commit,
    source_state: state
  };
}
