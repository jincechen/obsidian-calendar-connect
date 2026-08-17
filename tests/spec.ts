// Entry point for `npm test`. Each area registers its checks on import; the
// summary is printed once every async check has settled.
import "./settings.test";
import "./safety.test";
import "./http.test";
import "./auth.test";
import "./google.test";
import { report } from "./harness";

void report().then((failed) => process.exit(failed === 0 ? 0 : 1));
