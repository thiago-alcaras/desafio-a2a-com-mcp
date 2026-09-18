import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequestStateCodec } from "@modelcontextprotocol/server";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rooms = JSON.parse(readFileSync(join(root, "dados", "salas.json"), "utf8"));
const reservations = JSON.parse(readFileSync(join(root, "dados", "reservas.json"), "utf8"));
const policy = readFileSync(join(root, "dados", "politica-de-uso.md"), "utf8");
const secret = process.env.REQUEST_STATE_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) {
  console.error("REQUEST_STATE_SECRET must contain at least 32 bytes.");
  process.exit(1);
}

const PORT = Number(process.env.MCP_PORT || 7301);
const PROTOCOL = "2026-07-28";
const SERVER_META = { "io.modelcontextprotocol/serverInfo": { name: "central-de-salas", version: "1.0.0" } };
const requestStateCodec = createRequestStateCodec({ key: secret, ttlSeconds: 15 * 60 });
let nextReservation = reservations.length + 1;

const schemas = {
  listar_salas: { type: "object", properties: {}, additionalProperties: false },
  consultar_disponibilidade: {
    type: "object", properties: { sala: { type: "string" }, inicio: { type: "string" }, fim: { type: "string" } }, required: ["sala", "inicio", "fim"], additionalProperties: false,
  },
  reservar_sala: {
    type: "object", properties: { sala: { type: "string" }, inicio: { type: "string" }, fim: { type: "string" }, responsavel: { type: "string" } }, required: ["sala", "inicio", "fim", "responsavel"], additionalProperties: false,
  },
};

async function seal(payload) { return requestStateCodec.mint(payload); }
async function openState(value) { return requestStateCodec.verify(value); }
function rpcError(id, code, message, data) { return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }; }
function complete(structuredContent, isError = false) {
  return { resultType: "complete", ...(isError ? { isError: true } : {}), structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }], _meta: SERVER_META };
}
function toolError(message) { return complete({ erro: message }, true); }
function parseTime(value) { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
function validate(args) {
  const room = rooms.find((item) => item.id === args.sala);
  if (!room) return `Sala inexistente: ${args.sala}`;
  const start = parseTime(args.inicio); const end = parseTime(args.fim);
  if (!start || !end || end <= start) return "Intervalo invalido: fim deve ser posterior a inicio";
  const startHour = new Date(start).getUTCHours() - 3; const endHour = new Date(end).getUTCHours() - 3;
  if (startHour < 8 || endHour > 20 || (endHour === 20 && new Date(end).getUTCMinutes() !== 0)) return "Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00";
  if (end - start > 2 * 60 * 60 * 1000) return "Duracao acima do limite: a politica permite no maximo 2 horas";
  return null;
}
function conflicts(sala, inicio, fim) {
  const start = parseTime(inicio), end = parseTime(fim);
  return reservations.filter((item) => item.sala === sala && start < parseTime(item.fim) && end > parseTime(item.inicio));
}
function alternatives(args) {
  const requested = rooms.find((item) => item.id === args.sala);
  return rooms.filter((room) => room.id !== args.sala && room.capacidade >= requested.capacidade && conflicts(room.id, args.inicio, args.fim).length === 0)
    .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id))
    .slice(0, 3);
}
function reserve(args) {
  const reservation = { id: `res-${String(nextReservation++).padStart(4, "0")}`, sala: args.sala, inicio: args.inicio, fim: args.fim, responsavel: args.responsavel };
  reservations.push(reservation);
  return { reserva: reservation.id, reservado: true, sala: reservation.sala, inicio: reservation.inicio, fim: reservation.fim, responsavel: reservation.responsavel, politica: "2026-11-01", motivo: null };
}
function hasElicitation(meta) { return Boolean(meta?.["io.modelcontextprotocol/clientCapabilities"]?.elicitation?.form); }
function validateMeta(params) {
  const meta = params?._meta;
  if (!meta?.["io.modelcontextprotocol/protocolVersion"] || !Object.prototype.hasOwnProperty.call(meta, "io.modelcontextprotocol/clientCapabilities")) return false;
  return true;
}
async function runTool(params) {
  const { name, arguments: args = {} } = params;
  if (name === "listar_salas") return complete({ salas: rooms });
  if (name === "consultar_disponibilidade") {
    const error = validate(args); if (error) return toolError(error);
    const found = conflicts(args.sala, args.inicio, args.fim);
    return complete({ sala: args.sala, livre: found.length === 0, conflitos: found });
  }
  if (name !== "reservar_sala") return toolError(`Tool inexistente: ${name}`);

  if (params.requestState) {
    let sealed;
    try { sealed = await openState(params.requestState); } catch (error) { throw error; }
    const answer = params.inputResponses?.[sealed.key];
    if (!answer) throw new Error("Invalid input response");
    if (answer.action === "decline" || answer.action === "cancel") return complete({ reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo: "recusado" });
    const selected = answer.content?.sala;
    if (answer.action !== "accept" || !sealed.alternatives.includes(selected)) throw new Error("Invalid input response");
    const finalArgs = { ...sealed.arguments, sala: selected };
    if (conflicts(finalArgs.sala, finalArgs.inicio, finalArgs.fim).length) return toolError("Sem alternativas disponiveis no intervalo");
    return complete(reserve(finalArgs));
  }

  const error = validate(args); if (error) return toolError(error);
  if (conflicts(args.sala, args.inicio, args.fim).length === 0) return complete(reserve(args));
  const options = alternatives(args).map((room) => room.id);
  if (!options.length) return toolError("Sem alternativas disponiveis no intervalo");
  if (!hasElicitation(params._meta)) {
    const protocolError = new Error("Client did not declare form elicitation capability");
    protocolError.code = -32021; protocolError.data = { requiredCapabilities: { elicitation: { form: {} } } };
    throw protocolError;
  }
  const key = "escolha_de_sala";
  return { resultType: "input_required", inputRequests: { [key]: { method: "elicitation/create", params: { mode: "form", message: "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.", requestedSchema: { type: "object", properties: { sala: { type: "string", enum: options } }, required: ["sala"] } } } }, requestState: await seal({ key, arguments: args, alternatives: options }), _meta: SERVER_META };
}

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
  let raw = ""; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { res.writeHead(400).end(JSON.stringify(rpcError(null, -32700, "Parse error"))); return; }
  const { id, method, params = {} } = body;
  console.error(JSON.stringify({ method, id, traceparent: params._meta?.traceparent || null }));
  if (!validateMeta(params)) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, -32602, "Missing required request metadata"))); return; }
  if (req.headers["mcp-method"] && req.headers["mcp-method"] !== method) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, -32020, "Mcp-Method header does not match body"))); return; }
  if (req.headers["mcp-name"] && method === "tools/call" && req.headers["mcp-name"] !== params.name) { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, -32020, "Mcp-Name header does not match body"))); return; }
  try {
    let result;
    if (method === "tools/list") result = { tools: Object.entries(schemas).map(([name, inputSchema]) => ({ name, description: name, inputSchema, outputSchema: { type: "object" } })), _meta: SERVER_META };
    else if (method === "resources/read") {
      if (params.uri !== "politica://uso") { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, -32602, "Resource not found"))); return; }
      result = { resultType: "complete", ttlMs: 0, contents: [{ uri: "politica://uso", mimeType: "text/markdown", text: policy }], _meta: SERVER_META };
    } else if (method === "tools/call") result = await runTool(params);
    else { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, -32601, "Method not found"))); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  } catch (error) {
    const code = error.code || -32602;
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(id, code, error.message, error.data)));
  }
}).listen(PORT, () => console.error(`MCP listening on ${PORT}`));
