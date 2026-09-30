export function assertExactCleanSource({ requestedCommit, headCommit, dirtyStatus }) {
  if (!/^[0-9a-f]{40}$/u.test(requestedCommit ?? "")) throw new Error("Pass the exact full 40-character source commit to deploy.");
  if (headCommit !== requestedCommit) throw new Error(`Source HEAD is ${headCommit}; refusing to deploy requested commit ${requestedCommit}.`);
  if (dirtyStatus) throw new Error("Source checkout is dirty; commit the intended build before local deployment.");
}

export function buildIdentityMatches(identity, { commit, version }) {
  return identity?.package_version === version
    && identity?.source_commit === commit
    && identity?.source_state === "clean";
}

export async function restorePriorPackage({ reason, packageRoot, installPrevious, verifyPrevious }) {
  let restored = false;
  try { restored = await installPrevious(); } catch { restored = false; }
  let verified = false;
  try { verified = restored && await verifyPrevious(); } catch { verified = false; }
  if (!verified) throw new Error(`${reason} Previous package rollback could not be proven; inspect ${packageRoot} before restarting.`);
  throw new Error(`${reason} Previous package was restored and verified; no success was reported.`);
}
