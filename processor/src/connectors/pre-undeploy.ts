/**
 * Deliberately a no-op. The cart Type and the denomination CartDiscounts stay behind on undeploy:
 * orders already carry references to them, and a redeploy converges onto the same objects anyway.
 */
async function preUndeploy() {
  // Nothing to tear down.
}

async function run() {
  try {
    await preUndeploy();
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`Pre-undeploy failed: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}
run();
