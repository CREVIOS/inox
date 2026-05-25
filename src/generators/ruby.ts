import type { ApiIR, OperationIR, ResourceIR } from "../types.js";
import { pascalCase, quote, snakeCase } from "../utils.js";
import { renderRubyConformanceTest } from "../conformance.js";
import { renderReleaseWorkflow } from "../release.js";
import {
  childResources,
  createTargetWriter,
  emittedResources,
  paginationShape,
  resourceFileSlug,
  targetOperationsForResource,
  topLevelResources,
} from "./common.js";

function gemName(ir: ApiIR): string {
  return snakeCase(ir.targets.ruby?.gem_name ?? ir.targets.ruby?.package_name ?? ir.api.package_prefix.replace(/-api$/, ""));
}

function moduleName(ir: ApiIR): string {
  return pascalCase(gemName(ir));
}

export async function generateRuby(ir: ApiIR, rootOutDir: string): Promise<import("../types.js").GenerationResult> {
  const writer = createTargetWriter("ruby", rootOutDir);
  const gem = gemName(ir);
  const mod = moduleName(ir);
  const version = ir.api.version ?? "0.1.0";

  await writer.write(
    `${gem}.gemspec`,
    `Gem::Specification.new do |spec|
  spec.name = ${quote(gem)}
  spec.version = ${quote(version)}
  spec.summary = ${quote(`${ir.api.name} Ruby SDK`)}
  spec.authors = ["sdkgen"]
  spec.files = Dir["lib/**/*.rb"]
  spec.require_paths = ["lib"]
  spec.required_ruby_version = ">= 3.0"
end
`,
  );

  await writer.write(`lib/${gem}.rb`, renderRubyRoot(ir, gem, mod));
  await writer.write(`lib/${gem}/errors.rb`, renderRubyErrors(mod));
  await writer.write(`lib/${gem}/client.rb`, renderRubyClient(ir, mod));
  await writer.write(`lib/${gem}/otel.rb`, renderRubyOtel(mod));
  if (ir.webhooks) await writer.write(`lib/${gem}/webhooks.rb`, renderRubyWebhooks(ir, mod));
  for (const resource of emittedResources(ir, "ruby")) {
    await writer.write(`lib/${gem}/resources/${resourceFileSlug(resource)}.rb`, renderRubyResource(ir, mod, resource));
  }
  await writer.write("test/conformance.rb", renderRubyConformanceTest(ir, gem, mod));
  await writer.write(".github/workflows/release.yml", renderReleaseWorkflow("ruby", ir));
  await writer.write("README.md", `# ${ir.api.name} Ruby SDK\n\n\`\`\`ruby\nrequire "${gem}"\nclient = ${mod}::Client.new\n\`\`\`\n`);
  return writer.result();
}

function renderRubyRoot(ir: ApiIR, gem: string, mod: string): string {
  const requires = [
    `require_relative "${gem}/errors"`,
    `require_relative "${gem}/client"`,
    `require_relative "${gem}/otel"`,
    ...(ir.webhooks ? [`require_relative "${gem}/webhooks"`] : []),
    ...emittedResources(ir, "ruby").map((resource) => `require_relative "${gem}/resources/${resourceFileSlug(resource)}"`),
  ];
  return `${requires.join("\n")}

module ${mod}
end
`;
}

function renderRubyOtel(mod: string): string {
  // Optional OpenTelemetry instrumentation (zero dependency). Pass a tracer responding to
  // start_span(name, kind:) -> span with set_attribute(k, v), set_status(code), finish.
  // Usage: client = Mod::Client.new(**Mod::Otel.hooks(tracer))
  return `require "uri"

module ${mod}
  module Otel
    SPAN_KIND_CLIENT = 3
    STATUS_ERROR = 2

    def self.hooks(tracer)
      spans = {}
      key = ->(info) { "#{info[:method]} #{info[:url]} ##{info[:attempt]}" }
      {
        on_request: ->(info) {
          span = tracer.start_span(info[:method], kind: SPAN_KIND_CLIENT)
          span.set_attribute("http.request.method", info[:method])
          span.set_attribute("url.full", info[:url])
          host = (URI(info[:url]).host rescue nil)
          span.set_attribute("server.address", host) if host
          span.set_attribute("http.request.resend_count", info[:attempt]) if info[:attempt].to_i > 0
          spans[key.call(info)] = span
        },
        on_response: ->(info) {
          span = spans.delete(key.call(info))
          next unless span
          span.set_attribute("http.response.status_code", info[:status])
          span.set_status(STATUS_ERROR) if info[:status].to_i >= 400
          span.finish
        },
        on_error: ->(info) {
          span = spans.delete(key.call(info))
          next unless span
          span.set_attribute("error.type", info[:error].class.name)
          span.set_status(STATUS_ERROR)
          span.finish
        },
      }
    end
  end
end
`;
}

function renderRubyErrors(mod: string): string {
  return `module ${mod}
  class ApiError < StandardError
    attr_reader :status_code, :body

    def initialize(status_code, body)
      super("API request failed with status #{status_code}")
      @status_code = status_code
      @body = body
    end
  end
end
`;
}

function renderRubyClient(ir: ApiIR, mod: string): string {
  const resources = topLevelResources(ir, "ruby");
  const oauth = ir.client.oauth2;
  const resourceAttrs = resources.map((resource) => `:${resource.name}`).join(", ");
  const resourceInit = resources
    .map((resource) => `      @${resource.name} = ${resource.class_name}Resource.new(self)`)
    .join("\n");
  const webhookAttr = ir.webhooks ? "    attr_reader :webhooks\n" : "";
  const webhookInit = ir.webhooks ? "      @webhooks = WebhookClient.new(secret: webhook_secret)\n" : "";
  const initParams = [
    "api_key: nil",
    ...(oauth ? ["client_id: nil", "client_secret: nil"] : []),
    "base_url: nil",
    "environment: nil",
    `timeout: ${ir.client.timeout_ms / 1000}`,
    `max_retries: ${ir.client.retry_policy.max_retries}`,
    `omit_stainless_headers: ${ir.client.omit_stainless_headers ? "true" : "false"}`,
    "on_request: nil",
    "on_response: nil",
    "on_error: nil",
    ...(ir.webhooks ? ["webhook_secret: nil"] : []),
  ].join(",\n      ");

  const oauthInit = oauth
    ? `      @client_id = client_id || ENV[${quote(oauth.client_id_env)}]
      @client_secret = client_secret || ENV[${quote(oauth.client_secret_env)}]
      @oauth2_token_url = ${quote(oauth.token_url)}
      @oauth2_scopes = ${JSON.stringify(oauth.scopes)}
      @oauth2_auth_style = ${quote(oauth.auth_style)}
      @cached_token = nil
      @token_expiry = 0
`
    : "      @client_id = nil\n      @client_secret = nil\n";

  const tokenMethod = oauth
    ? `
    def get_token(force = false)
      return nil unless @client_id && @client_secret
      return @cached_token if !force && @cached_token && Time.now.to_f < @token_expiry
      token_url = @oauth2_token_url.start_with?("http") ? @oauth2_token_url : "#{@base_url}#{@oauth2_token_url}"
      form = { "grant_type" => "client_credentials" }
      form["scope"] = @oauth2_scopes.join(" ") unless @oauth2_scopes.empty?
      headers = { "content-type" => "application/x-www-form-urlencoded", "accept" => "application/json" }
      if @oauth2_auth_style == "basic"
        headers["authorization"] = "Basic " + Base64.strict_encode64("#{@client_id}:#{@client_secret}")
      else
        form["client_id"] = @client_id
        form["client_secret"] = @client_secret
      end
      uri = URI(token_url)
      req = Net::HTTP::Post.new(uri)
      headers.each { |k, v| req[k] = v }
      req.body = URI.encode_www_form(form)
      response = http_for(uri).request(req)
      payload = JSON.parse(response.body)
      @cached_token = payload["access_token"]
      @token_expiry = Time.now.to_f + (payload.fetch("expires_in", 3600) - 30)
      @cached_token
    end

    def resolve_bearer
      return get_token if @client_id && @client_secret
      @api_key
    end
`
    : `
    def resolve_bearer
      @api_key
    end
`;

  return `require "net/http"
require "uri"
require "json"
require "securerandom"
require "base64"

module ${mod}
  class Client
    ENVIRONMENTS = {${Object.entries(ir.client.environments).map(([key, url]) => `${quote(key)} => ${quote(url)}`).join(", ")}}.freeze
    ${webhookAttr}    attr_reader ${resourceAttrs || ":_unused"}

    def initialize(
      ${initParams}
    )
      @api_key = api_key || ENV[${quote(`${ir.client.env_prefix}_API_KEY`)}]
      @base_url = (base_url || ENVIRONMENTS[environment] || ${quote(ir.client.base_url)}).sub(/\\/$/, "")
      @timeout = timeout
      @max_retries = max_retries
      @retry_statuses = ${JSON.stringify(ir.client.retry_policy.retry_statuses)}
      @omit_stainless_headers = omit_stainless_headers
      @idempotency_header = ${ir.client.idempotency_header ? quote(ir.client.idempotency_header) : "nil"}
      @package_version = ${quote(ir.api.version ?? "0.1.0")}
      @on_request = on_request
      @on_response = on_response
      @on_error = on_error
${oauthInit}${webhookInit}${resourceInit}
    end

    def request(method, path, query: nil, body: nil, headers: nil, multipart: false, idempotency_key: nil, timeout: nil, max_retries: nil, binary: false)
      effective_retries = max_retries || @max_retries
      effective_timeout = timeout || @timeout
      uri = URI("#{@base_url}#{path}")
      if query
        clean = query.reject { |_, value| value.nil? }
        uri.query = URI.encode_www_form(clean) unless clean.empty?
      end
      req_headers = build_headers(headers, resolve_bearer)
      data = nil
      if multipart && body.is_a?(Hash)
        boundary = "----sdkgen#{SecureRandom.hex(16)}"
        data = encode_multipart(body, boundary)
        req_headers["content-type"] = "multipart/form-data; boundary=#{boundary}"
      elsif !body.nil?
        req_headers["content-type"] = "application/json"
        data = JSON.generate(body)
      end
      if @idempotency_header && method.downcase != "get" && !req_headers.key?(@idempotency_header)
        req_headers[@idempotency_header] = idempotency_key || "stainless-retry-#{SecureRandom.hex(16)}"
      end

      refreshed = false
      attempt = 0
      loop do
        req_headers["x-stainless-retry-count"] = attempt.to_s unless @omit_stainless_headers
        request_obj = build_net_request(method, uri, data, req_headers)
        started = Time.now
        @on_request&.call({ method: method.upcase, url: uri.to_s, attempt: attempt })
        begin
          response = http_for(uri).request(request_obj)
        rescue StandardError => error
          @on_error&.call({ method: method.upcase, url: uri.to_s, attempt: attempt, error: error })
          raise if attempt >= effective_retries
          sleep(backoff(attempt))
          attempt += 1
          next
        end
        status = response.code.to_i
        @on_response&.call({ method: method.upcase, url: uri.to_s, attempt: attempt, status: status, duration_ms: (Time.now - started) * 1000 })
        if status == 401 && @client_id && @client_secret && !refreshed
          refreshed = true
          req_headers["authorization"] = "Bearer #{get_token(true)}"
          next
        end
        if status >= 200 && status < 300
          return response.body if binary
          return response.body.nil? || response.body.empty? ? nil : JSON.parse(response.body)
        end
        if attempt < effective_retries && should_retry?(response, status)
          sleep(backoff(attempt, response))
          attempt += 1
          next
        end
        parsed = begin
          JSON.parse(response.body)
        rescue StandardError
          response.body
        end
        raise ApiError.new(status, parsed)
      end
    end

    def stream(method, path, query: nil, body: nil, headers: nil, sse: true, done_sentinel: nil)
      uri = URI("#{@base_url}#{path}")
      if query
        clean = query.reject { |_, value| value.nil? }
        uri.query = URI.encode_www_form(clean) unless clean.empty?
      end
      req_headers = build_headers(headers, resolve_bearer)
      req_headers["accept"] = "text/event-stream"
      data = nil
      unless body.nil?
        req_headers["content-type"] = "application/json"
        data = JSON.generate(body)
      end
      Enumerator.new do |yielder|
        request_obj = build_net_request(method, uri, data, req_headers)
        http_for(uri).request(request_obj) do |response|
          raise ApiError.new(response.code.to_i, response.body) unless response.code.to_i.between?(200, 299)
          buffer = +""
          data_lines = []
          response.read_body do |chunk|
            buffer << chunk
            while (index = buffer.index("\\n"))
              line = buffer[0...index].chomp("\\r")
              buffer = buffer[(index + 1)..] || +""
              if sse
                if line.empty?
                  unless data_lines.empty?
                    payload = data_lines.join("\\n")
                    data_lines = []
                    yielder << JSON.parse(payload) unless done_sentinel && payload == done_sentinel
                  end
                elsif line.start_with?("data:")
                  data_lines << line[5..].sub(/^ /, "")
                end
              elsif !line.strip.empty?
                yielder << JSON.parse(line) unless done_sentinel && line.strip == done_sentinel
              end
            end
          end
        end
      end
    end

    private

    def build_headers(extra, bearer)
      headers = { "accept" => "application/json" }
      headers.merge!(extra) if extra
      unless @omit_stainless_headers
        headers["x-stainless-lang"] = "ruby"
        headers["x-stainless-package-version"] = @package_version
        headers["x-stainless-runtime"] = "ruby"
        headers["x-stainless-runtime-version"] = RUBY_VERSION
        headers["x-stainless-timeout"] = @timeout.to_s
      end
      headers["authorization"] = "Bearer #{bearer}" if bearer
      headers
    end

    def http_for(uri, timeout = @timeout)
      http = Net::HTTP.new(uri.host, uri.port)
      http.use_ssl = uri.scheme == "https"
      http.read_timeout = timeout
      http.open_timeout = timeout
      http
    end

    def build_net_request(method, uri, data, headers)
      klass = {
        "get" => Net::HTTP::Get, "post" => Net::HTTP::Post, "put" => Net::HTTP::Put,
        "patch" => Net::HTTP::Patch, "delete" => Net::HTTP::Delete, "head" => Net::HTTP::Head
      }[method.downcase] || Net::HTTP::Get
      request_obj = klass.new(uri)
      headers.each { |key, value| request_obj[key] = value }
      request_obj.body = data if data
      request_obj
    end

    def should_retry?(response, status)
      should = response["x-should-retry"]
      return true if should == "true"
      return false if should == "false"
      @retry_statuses.include?(status) || status >= 500
    end

    def backoff(attempt, response = nil)
      if response
        ms = response["retry-after-ms"]
        return ms.to_f / 1000 if ms && ms.to_f >= 0 && ms.to_f < 60_000
        secs = response["retry-after"]
        return secs.to_f if secs && secs.to_f >= 0 && secs.to_f < 60
      end
      [8.0, 0.5 * (2**attempt)].min * (0.75 + rand * 0.5)
    end

    def encode_multipart(fields, boundary)
      body = +""
      fields.each do |key, value|
        next if value.nil?
        body << "--#{boundary}\\r\\n"
        if value.respond_to?(:read)
          body << "Content-Disposition: form-data; name=\\"#{key}\\"; filename=\\"#{key}\\"\\r\\n"
          body << "Content-Type: application/octet-stream\\r\\n\\r\\n"
          body << value.read.to_s << "\\r\\n"
        elsif value.is_a?(Hash) && value[:content]
          body << "Content-Disposition: form-data; name=\\"#{key}\\"; filename=\\"#{value.fetch(:filename, key)}\\"\\r\\n"
          body << "Content-Type: application/octet-stream\\r\\n\\r\\n"
          body << value[:content].to_s << "\\r\\n"
        else
          body << "Content-Disposition: form-data; name=\\"#{key}\\"\\r\\n\\r\\n"
          body << value.to_s << "\\r\\n"
        end
      end
      body << "--#{boundary}--\\r\\n"
      body
    end
${tokenMethod.split("\n").map((line) => (line ? `  ${line}` : line)).join("\n")}
  end
end
`;
}

function renderRubyWebhooks(ir: ApiIR, mod: string): string {
  const webhook = ir.webhooks;
  if (!webhook) return "";
  return `require "openssl"
require "json"

module ${mod}
  class WebhookVerificationError < StandardError; end

  class WebhookClient
    def initialize(secret: nil, tolerance_seconds: ${webhook.tolerance_seconds})
      @secret = secret || ENV[${quote(webhook.signing_secret_env)}]
      @tolerance = tolerance_seconds
    end

    def unwrap(payload, headers)
      verify_signature(payload, headers)
      JSON.parse(payload.is_a?(String) ? payload : payload.to_s)
    end

    def verify_signature(payload, headers)
      raise WebhookVerificationError, "Missing webhook signing secret" unless @secret
      signature_header = header_value(headers, ${quote(webhook.signature_header)})
      raise WebhookVerificationError, "Missing webhook signature header" unless signature_header
      parsed = parse_signature_header(signature_header)
      timestamp = header_value(headers, ${quote(webhook.timestamp_header)}) || parsed["t"]
      raise WebhookVerificationError, "Missing webhook timestamp" unless timestamp
      assert_fresh(timestamp)
      signature = parsed["v1"] || parsed["sha256"] || parsed["signature"] || parsed["raw"]
      raise WebhookVerificationError, "Missing webhook signature value" unless signature
      expected = OpenSSL::HMAC.hexdigest("SHA256", @secret, "#{timestamp}.#{payload}")
      raise WebhookVerificationError, "Webhook signature mismatch" unless secure_compare(expected, signature)
      true
    end

    private

    def header_value(headers, name)
      wanted = name.downcase
      headers.each do |key, value|
        next unless key.to_s.downcase == wanted
        return value.is_a?(Array) ? value.first : value
      end
      nil
    end

    def parse_signature_header(value)
      result = {}
      value.split(",").each do |part|
        trimmed = part.strip
        next if trimmed.empty?
        if trimmed.include?("=")
          key, val = trimmed.split("=", 2)
          result[key.strip.downcase] = val.strip
        else
          result["raw"] = trimmed
        end
      end
      result
    end

    def assert_fresh(value)
      timestamp = Integer(value)
      raise WebhookVerificationError, "Webhook timestamp outside tolerance" if (Time.now.to_i - timestamp).abs > @tolerance
    rescue ArgumentError
      raise WebhookVerificationError, "Invalid webhook timestamp"
    end

    def secure_compare(a, b)
      return false unless a.bytesize == b.bytesize
      left = a.unpack("C*")
      result = 0
      b.each_byte.with_index { |byte, index| result |= byte ^ left[index] }
      result.zero?
    end
  end
end
`;
}

interface RbPlan {
  positional: string[];
  pathInterp: string;
  query: Array<{ name: string; wire: string }>;
}

function rbPlan(operation: OperationIR): RbPlan {
  const pathParams = operation.params.filter((param) => param.location === "path");
  const queryParams = operation.params.filter((param) => param.location === "query");
  const positional = pathParams.map((param) => snakeCase(param.name));
  if (operation.request) positional.push("body");
  return {
    positional,
    pathInterp: operation.path.replace(/\{([^}]+)\}/g, (_m, name: string) => `#{${snakeCase(name)}}`),
    query: queryParams.map((param) => ({ name: snakeCase(param.name), wire: param.wire_name })),
  };
}

function rbSignature(plan: RbPlan, extra: string[] = []): string {
  const parts = [...plan.positional, ...plan.query.map((q) => `${q.name}: nil`), "headers: nil", ...extra];
  return parts.join(", ");
}

function rbQueryHash(plan: RbPlan): string {
  if (plan.query.length === 0) return "nil";
  return `{ ${plan.query.map((q) => `${quote(q.wire)} => ${q.name}`).join(", ")} }`;
}

function renderRubyResource(ir: ApiIR, mod: string, resource: ResourceIR): string {
  const operations = targetOperationsForResource(ir, resource, "ruby");
  const children = childResources(ir, resource, "ruby");
  const childAttrs = children.map((child) => `:${child.name}`);
  const childInit = children.map((child) => `      @${child.name} = ${child.class_name}Resource.new(client)`).join("\n");
  const methods = operations.flatMap((operation) => renderRubyOperation(ir, operation)).filter(Boolean).join("\n\n");

  return `module ${mod}
  class ${resource.class_name}Resource
${childAttrs.length ? `    attr_reader ${childAttrs.join(", ")}\n` : ""}
    def initialize(client)
      @client = client
${childInit}
    end

${methods}
  end
end
`;
}

function renderRubyOperation(ir: ApiIR, operation: OperationIR): string[] {
  if (operation.websocket) return [];
  const out: string[] = [];
  if (operation.streaming) {
    if (!operation.streaming.always) out.push(renderRubyMethod(operation, "non-stream"));
    out.push(renderRubyStreamingMethod(operation));
  } else {
    out.push(renderRubyMethod(operation, "plain"));
  }
  const pager = renderRubyPagerWithIr(ir, operation);
  if (pager) out.push(pager);
  if (operation.deprecated) {
    const reason = typeof operation.deprecated === "string" ? ` ${operation.deprecated}` : "";
    return out.map((method, index) => (index === 0 ? `# @deprecated${reason}\n${method}` : method));
  }
  return out;
}

function renderRubyMethod(operation: OperationIR, mode: "plain" | "non-stream"): string {
  const plan = rbPlan(operation);
  const signature = rbSignature(plan, ["idempotency_key: nil"]);
  const discriminator = mode === "non-stream" ? operation.streaming?.param_discriminator : undefined;
  const bodyArg = operation.request
    ? discriminator
      ? `body: body.merge(${quote(discriminator)} => false)`
      : "body: body"
    : "";
  const multipart = operation.request?.multipart ? ", multipart: true" : "";
  const binary = operation.binary_response ? ", binary: true" : "";
  const callArgs = [
    `query: ${rbQueryHash(plan)}`,
    bodyArg,
    "headers: headers",
    "idempotency_key: idempotency_key",
  ].filter(Boolean).join(", ");
  return `    def ${snakeCase(operation.name)}(${signature})
      @client.request(${quote(operation.http_method)}, "${plan.pathInterp}", ${callArgs}${multipart}${binary})
    end`;
}

function renderRubyStreamingMethod(operation: OperationIR): string {
  const streaming = operation.streaming;
  if (!streaming) return "";
  const plan = rbPlan(operation);
  const signature = rbSignature(plan);
  const name = streaming.always ? snakeCase(operation.name) : `${snakeCase(operation.name)}_streaming`;
  const discriminator = streaming.param_discriminator;
  const bodyArg = operation.request
    ? discriminator
      ? `body: body.merge(${quote(discriminator)} => true)`
      : "body: body"
    : "";
  const sse = streaming.protocol === "sse" ? "true" : "false";
  const done = streaming.done_sentinel ? `, done_sentinel: ${quote(streaming.done_sentinel)}` : "";
  const callArgs = [`query: ${rbQueryHash(plan)}`, bodyArg, "headers: headers", `sse: ${sse}${done}`].filter(Boolean).join(", ");
  return `    def ${name}(${signature})
      @client.stream(${quote(operation.http_method)}, "${plan.pathInterp}", ${callArgs})
    end`;
}

function renderRubyPagerWithIr(ir: ApiIR, operation: OperationIR): string {
  const shape = paginationShape(ir, operation);
  if (!shape) return "";
  const plan = rbPlan(operation);
  const signature = rbSignature(plan);
  const callArgs = [...plan.positional.filter((p) => p !== "body"), ...plan.query.map((q) => `${q.name}: ${q.name}`), "headers: headers"].join(", ");
  const itemsKey = quote(shape.itemsField.wire_name);
  const advance = rubyPagerAdvance(shape);
  const init = shape.kind === "offset" && shape.offsetParam
    ? `      ${snakeCase(shape.offsetParam)} ||= 0\n`
    : shape.kind === "page_number" && shape.pageParam
      ? `      ${snakeCase(shape.pageParam)} ||= 1\n`
      : "";
  return `    def ${snakeCase(operation.name)}_auto_paging(${signature})
      return enum_for(:${snakeCase(operation.name)}_auto_paging, ${rbEnumArgs(plan)}) unless block_given?
${init}      loop do
        page = ${snakeCase(operation.name)}(${callArgs})
        items = page[${itemsKey}] || []
        items.each { |item| yield item }
${advance}
      end
    end`;
}

function rbEnumArgs(plan: RbPlan): string {
  const parts = [...plan.positional.filter((p) => p !== "body"), ...plan.query.map((q) => `${q.name}: ${q.name}`), "headers: headers"];
  return parts.join(", ");
}

function rubyPagerAdvance(shape: NonNullable<ReturnType<typeof paginationShape>>): string {
  switch (shape.kind) {
    case "cursor": {
      if (!shape.nextCursorField || !shape.requestCursorParam) return "        break";
      return `        ${snakeCase(shape.requestCursorParam)} = page[${quote(shape.nextCursorField.wire_name)}]
        break unless ${snakeCase(shape.requestCursorParam)}`;
    }
    case "cursor_id": {
      if (!shape.cursorIdParam || !shape.cursorItemIdField) return "        break";
      return `        break if items.empty?
        ${snakeCase(shape.cursorIdParam)} = items.last[${quote(shape.cursorItemIdField.wire_name)}]
        break unless ${snakeCase(shape.cursorIdParam)}`;
    }
    case "offset": {
      if (!shape.offsetParam) return "        break";
      const total = shape.totalCountField
        ? `\n        total = page[${quote(shape.totalCountField.wire_name)}]
        break if total && ${snakeCase(shape.offsetParam)} + items.length >= total`
        : "";
      return `        break if items.empty?${total}
        ${snakeCase(shape.offsetParam)} += items.length`;
    }
    case "page_number": {
      if (!shape.pageParam) return "        break";
      const current = shape.currentPageField ? `page[${quote(shape.currentPageField.wire_name)}] || ${snakeCase(shape.pageParam)}` : snakeCase(shape.pageParam);
      const total = shape.totalPagesField
        ? `\n        total_pages = page[${quote(shape.totalPagesField.wire_name)}]
        break if total_pages && current >= total_pages`
        : "";
      return `        break if items.empty?
        current = ${current}${total}
        ${snakeCase(shape.pageParam)} = current + 1`;
    }
    case "cursor_url": {
      if (!shape.nextUrlField) return "        break";
      return `        break`;
    }
    default:
      return "        break";
  }
}
