/**
 * Fetch the field-ops crew sheet LIVE (in-memory, no filesystem) and parse it to
 * a per-day crew map. SERVER-ONLY (lib/drive reads GOOGLE_SERVICE_ACCOUNT_KEY).
 * For the nightly cron, which runs on a read-only serverless filesystem where
 * `drive pull` (which writes a committed snapshot) cannot run. Under
 * --conditions=react-server (the CLIs) `server-only` resolves to an empty module.
 */
import "server-only";
import { fetchExport } from "./drive";
import { crewByDate, parseCsv } from "./crewSheet";
import { FIELD_OPS_CREW_SOURCE } from "./crewImport";

export async function crewFromLiveSheet(): Promise<Map<string, string[]>> {
  const { text } = await fetchExport(FIELD_OPS_CREW_SOURCE);
  return crewByDate(parseCsv(text));
}
