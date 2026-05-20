import { writeFileSync } from "node:fs";
import { join } from "node:path";

const apiBaseUrl = process.env.API_BASE_URL || "";
const wsBaseUrl = process.env.WS_BASE_URL || "";

const content = `window.CODEX_CHAT_CONFIG = ${JSON.stringify(
  {
    apiBaseUrl,
    wsBaseUrl
  },
  null,
  2
)};\n`;

writeFileSync(join(process.cwd(), "public", "runtime-config.js"), content, "utf8");
console.log("Wrote public/runtime-config.js");
