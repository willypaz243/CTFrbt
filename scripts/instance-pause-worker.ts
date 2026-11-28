import { reconcileInstancePause } from "../src/lib/instance-pause-controller";
import { prisma } from "../src/lib/prisma";

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  console.log("Instance pause controller started (4 operations per batch)");
  while (!stopping) {
    let more = false;
    try {
      more = !!(await reconcileInstancePause());
    } catch {
      // Also handles deployment while migrations are still being applied.
      console.error("Instance pause reconciliation failed; retrying");
    }
    if (!stopping)
      await new Promise((resolve) => setTimeout(resolve, more ? 250 : 2000));
  }
  await prisma.$disconnect();
}
void main();
