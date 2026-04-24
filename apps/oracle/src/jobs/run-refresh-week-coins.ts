import { runWeek } from "./run-week.js";

runWeek({ refreshCurrentDraft: true }).then(() => {
  process.exit(0);
}).catch((error: unknown) => {
  console.error("refresh-week-coins failed", error);
  process.exit(1);
});
