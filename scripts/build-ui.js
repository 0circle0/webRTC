const path = require("path");
const esbuild = require("esbuild");

async function build() {
  try {
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "..", "ui", "app.js")],
      bundle: true,
      sourcemap: true,
      target: ["chrome100", "firefox100", "safari15"],
      format: "iife",
      platform: "browser",
      outfile: path.resolve(__dirname, "..", "ui", "dist", "app.js"),
      define: {
        "process.env.NODE_ENV": '"production"',
      },
      logLevel: "info",
    });
    console.log("UI build complete");
  } catch (err) {
    console.error("UI build failed");
    if (err.errors) {
      err.errors.forEach((e) => console.error(e));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

build();
