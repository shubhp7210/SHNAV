// Serves the admin site on its own address, separate from the main app:
//   npm run admin  →  http://localhost:8090
// localhost only (not reachable from other devices on your network).
import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  server: { host: "localhost", port: 8090, strictPort: true },
  preview: { host: "localhost", port: 8090, strictPort: true },
};
