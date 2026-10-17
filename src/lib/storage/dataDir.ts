import path from "node:path";

/**
 * Resolves the directory that holds all PraxelOps JSON stores.
 *
 * Evaluated on every call (never cached at module load) so that tests and
 * separate processes can point at an isolated directory via PRAXELOPS_DATA_DIR.
 *
 * NOTE: relative imports / node builtins only, so plain node can load this module.
 */
export function getDataDir(): string {
  const override = process.env.PRAXELOPS_DATA_DIR;
  if (override !== undefined && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), ".peos", "data");
}
