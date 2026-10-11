import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PROMOTE_REQUEST_FIELDS } from "../tools/management/cp_admin.js";

const contract = JSON.parse(
  readFileSync(join(process.cwd(), "contracts", "promote-request.contract.json"), "utf8"),
);

describe("SDK promote-request v2 reader binding", () => {
  it("binds the MCP wrapper to the exact canonical request field set", () => {
    expect(contract.version).toBe(2);
    expect(contract.endpoint).toBe("POST /cp/admin/promote");
    expect(contract.catalog).toEqual(["tenant-fleet"]);
    expect([...PROMOTE_REQUEST_FIELDS].sort()).toEqual(Object.keys(contract.fields).sort());
  });

  it("pins the synchronous fail-closed completion semantics", () => {
    expect(contract.completion.dry_run_complete).toBe(false);
    expect(contract.completion.wet_success_status).toBe(200);
    expect(contract.completion.wet_success_requires).toEqual([
      "results[tenant-fleet].status=ok",
      "complete=true",
      "exact immutable full-fleet coverage",
    ]);
  });
});
