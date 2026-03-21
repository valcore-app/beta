import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const artifactsPath = resolve(process.cwd(), "artifacts", "contracts");
const outDir = resolve(process.cwd(), "..", "web", "lib", "abi");
mkdirSync(outDir, { recursive: true });

const contracts = ["ValcoreV1", "StablecoinMock"];

for (const name of contracts) {
  const artifact = JSON.parse(
    readFileSync(resolve(artifactsPath, `${name}.sol`, `${name}.json`), "utf-8"),
  );
  const outPath = resolve(outDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify({ abi: artifact.abi }, null, 2));
}

