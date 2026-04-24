import { runWeek } from "./run-week.js";

runWeek().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error("run-week failed", error);
  process.exit(1);
});
