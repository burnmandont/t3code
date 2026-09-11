export const SUPPORTED_RUNTIME_PLATFORMS = Object.freeze({
  "linux-x64": Object.freeze({
    platform: "linux",
    arch: "x64",
    frpcArchiveDirectory: "frp_0.70.1_linux_amd64",
    frpcSha256: "333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6",
  }),
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    arch: "arm64",
    frpcArchiveDirectory: "frp_0.70.1_darwin_arm64",
    frpcSha256: "cfa733b5a261c1647edee3c1fc4133d2542989b28f5602e81d47fc821d25c55f",
  }),
});

export function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export function resolveRuntimePlatform(platform = process.platform, arch = process.arch) {
  const key = runtimePlatformKey(platform, arch);
  const target = SUPPORTED_RUNTIME_PLATFORMS[key];
  if (target === undefined) {
    throw new Error(`Sovereign runtime is not available for ${key}.`);
  }
  return { key, ...target };
}

export function runtimeArtifactNames(target) {
  return {
    artifactFileName: `t3-sovereign-runtime-${target.key}.tar.gz`,
    manifestFileName: `${target.key}.manifest.json`,
  };
}
