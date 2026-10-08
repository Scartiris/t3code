import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      banner: { js: "#!/usr/bin/env node\n" },
      // The deployment copies `dist/` to a host that has no node_modules for
      // this app, so the whole runtime closure — `effect`, the platform
      // package, and this repo's workspace packages — has to be inlined.
      // Nothing here loads a native addon, so there is no exemption list.
      deps: { alwaysBundle: () => true },
    },
    test: {
      // Every test opens a SQLite file; parallel files make timing-sensitive
      // assertions flaky for no gain.
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
