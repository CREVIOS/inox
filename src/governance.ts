// Policy-as-code API governance: a Spectral-style ruleset evaluated over the spec + IR and
// surfaced as diagnostics, so style/security/quality standards are enforced in CI rather
// than living in a PDF nobody reads. Pairs with the breaking-change gate (`diff --gate`).
import type { ApiIR, Diagnostic, OpenApiDocument } from "./types.js";
import { isHttpMethod } from "./openapi.js";
import { isRecord } from "./utils.js";

export interface GovernanceOptions {
  /** Escalate governance suggestions/warnings to blockers (fail CI). */
  strict?: boolean;
}

export function governanceDiagnostics(spec: OpenApiDocument, ir: ApiIR, options: GovernanceOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const escalate = (severity: Diagnostic["severity"]): Diagnostic["severity"] =>
    options.strict && (severity === "warning" || severity === "suggestion") ? "blocker" : severity;

  // Security must be declared when the API is not purely local.
  const baseUrl = ir.client.base_url;
  const hasSchemes = Boolean(spec.components?.securitySchemes && Object.keys(spec.components.securitySchemes).length > 0);
  const hasAuthConfig = Boolean(ir.client.auth?.bearer || ir.client.auth?.api_key || ir.client.oauth2);
  if (!hasSchemes && !hasAuthConfig && !/127\.0\.0\.1|localhost/.test(baseUrl)) {
    diagnostics.push({
      severity: escalate("warning"),
      code: "governance.security.undefined",
      message: "No security schemes or auth configuration found for a non-local API. Declare authentication.",
      location: "components.securitySchemes",
    });
  }

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!isRecord(pathItem)) continue;

    if (path !== path.toLowerCase()) {
      diagnostics.push({
        severity: escalate("warning"),
        code: "governance.naming.path_case",
        message: `Path ${path} contains uppercase characters; use lowercase path segments.`,
        location: `paths.${path}`,
      });
    }

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method) || !isRecord(operation)) continue;
      const location = `paths.${path}.${method}`;

      if (typeof operation.summary !== "string" && typeof operation.description !== "string") {
        diagnostics.push({
          severity: escalate("suggestion"),
          code: "governance.operation.summary_missing",
          message: `${method.toUpperCase()} ${path} has no summary or description.`,
          location,
        });
      }

      const responses = isRecord(operation.responses) ? operation.responses : {};
      const codes = Object.keys(responses);
      const hasError = codes.some((code) => /^(4|5)\d\d$/.test(code) || code === "default");
      if (codes.length > 0 && !hasError) {
        diagnostics.push({
          severity: escalate("warning"),
          code: "governance.error_model.missing",
          message: `${method.toUpperCase()} ${path} declares no 4xx/5xx (or default) error response.`,
          location,
        });
      }

      const success = responses["200"] ?? responses["201"];
      if (isRecord(success)) {
        const content = isRecord(success.content) ? success.content : undefined;
        const hasSchema = content
          ? Object.values(content).some((media) => isRecord(media) && isRecord(media.schema))
          : false;
        if (content && !hasSchema) {
          diagnostics.push({
            severity: escalate("suggestion"),
            code: "governance.response.schema_missing",
            message: `${method.toUpperCase()} ${path} success response has content but no schema.`,
            location,
          });
        }
      }
    }
  }

  // Pagination hygiene: list-style methods should be paginated.
  for (const operation of ir.operations) {
    if (operation.name === "list" && !operation.pagination_id) {
      diagnostics.push({
        severity: escalate("suggestion"),
        code: "governance.pagination.list_unpaginated",
        message: `Method ${operation.name} on ${operation.path} returns a list but is not paginated.`,
        location: operation.path,
      });
    }
  }

  return diagnostics;
}
