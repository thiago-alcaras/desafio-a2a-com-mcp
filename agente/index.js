import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.AGENT_PORT || 7300);
const MCP_URL = process.env.MCP_URL || "http://localhost:7301/mcp";
const tasks = new Map();
let discovered = false;
let policyVersion = null;
let rpcId = 0;

function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function id(prefix) { return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`; }
function taskMessage(task, text) { return { messageId: id("msg"), role: "ROLE_AGENT", parts: [{ text }], taskId: task.id, contextId: task.contextId }; }
function taskView(task) { return { id: task.id, contextId: task.contextId, status: task.status, history: task.history, artifacts: task.artifacts }; }
function traceFrom(request) { return request.headers.traceparent || null; }
async function mcp(method, params, name, traceparent) {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } };
  if (traceparent) meta.traceparent = traceparent;
  const response = await fetch(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(name ? { "Mcp-Name": name } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: `agent-${++rpcId}`, method, params: { ...params, _meta: meta } }) });
  return response.json();
}
async function initialize(traceparent) {
  if (discovered) return;
  const listing = await mcp("tools/list", {}, null, traceparent);
  if (!(listing.result?.tools || []).some((tool) => tool.name === "reservar_sala")) throw new Error("reservar_sala not discovered");
  const resource = await mcp("resources/read", { uri: "politica://uso" }, "politica://uso", traceparent);
  const match = resource.result?.contents?.[0]?.text?.match(/^versao:\s*(.+)$/m);
  if (!match) throw new Error("policy version missing");
  policyVersion = match[1].trim(); discovered = true;
}
function parseReservation(text) {
  const found = /^reservar\s+sala=(\S+)\s+inicio=(\S+)\s+fim=(\S+)\s+responsavel=(.+)$/.exec(text.trim());
  return found ? { sala: found[1], inicio: found[2], fim: found[3], responsavel: found[4] } : null;
}
function alternativeIds(result) {
  const request = Object.values(result.inputRequests || {})[0];
  const field = request?.params?.requestedSchema?.properties?.sala || {};
  return field.enum || (field.const ? [field.const] : []);
}
function setStatus(task, state, text) { const message = taskMessage(task, text); task.status = { state, message }; task.history.push(message); }
function finish(task, result) {
  const data = result.structuredContent;
  task.artifacts = [{ artifactId: id("art"), name: "reserva", parts: [{ text: JSON.stringify({ reserva: data.reserva, sala: data.sala, inicio: data.inicio, fim: data.fim, responsavel: data.responsavel, politica: policyVersion }) }] }];
  setStatus(task, "TASK_STATE_COMPLETED", `Reserva ${data.reserva} confirmada na ${data.sala}.`);
}
async function begin(task, args, traceparent) {
  await initialize(traceparent);
  const response = await mcp("tools/call", { name: "reservar_sala", arguments: args }, "reservar_sala", traceparent);
  if (response.error || response.result?.isError) { setStatus(task, "TASK_STATE_FAILED", response.error?.message || response.result?.content?.[0]?.text || "Falha na reserva"); return; }
  const result = response.result;
  if (result.resultType === "input_required") {
    const alternatives = alternativeIds(result);
    task.pending = { args, requestState: result.requestState, key: Object.keys(result.inputRequests)[0], alternatives };
    setStatus(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${alternatives.join(", ")}`);
  } else finish(task, result);
}
async function continueTask(task, text, traceparent) {
  const choice = /^escolha=(\S+)$/.exec(text.trim())?.[1];
  if (!choice || !task.pending) { setStatus(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${task.pending?.alternatives.join(", ") || ""}`); return; }
  if (choice === "recusar") {
    const response = await mcp("tools/call", { name: "reservar_sala", arguments: task.pending.args, inputResponses: { [task.pending.key]: { action: "decline" } }, requestState: task.pending.requestState }, "reservar_sala", traceparent);
    if (response.result?.structuredContent?.reservado === false) setStatus(task, "TASK_STATE_CANCELED", "Reserva recusada."); else setStatus(task, "TASK_STATE_FAILED", response.error?.message || "Falha ao recusar reserva");
    return;
  }
  if (!task.pending.alternatives.includes(choice)) { setStatus(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${task.pending.alternatives.join(", ")}`); return; }
  const response = await mcp("tools/call", { name: "reservar_sala", arguments: task.pending.args, inputResponses: { [task.pending.key]: { action: "accept", content: { sala: choice } } }, requestState: task.pending.requestState }, "reservar_sala", traceparent);
  if (response.error || response.result?.isError) { setStatus(task, "TASK_STATE_FAILED", response.error?.message || response.result?.content?.[0]?.text || "Falha na reserva"); return; }
  finish(task, response.result); delete task.pending;
}
const card = { name: "Central de Salas", description: "Reserva salas de reuniao da Hill Valley Tech.", version: "1.0.0", supportedInterfaces: [{ url: `http://localhost:${PORT}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }], capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [{ id: "reservar-sala", name: "Reservar sala", description: "Reserva uma sala de reuniao.", tags: ["salas", "agenda"], inputModes: ["text/plain"], outputModes: ["text/plain"] }] };
createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(card)); return; }
  if (request.method !== "POST" || request.url !== "/a2a") { response.writeHead(404).end(); return; }
  let raw = ""; for await (const chunk of request) raw += chunk;
  let body; try { body = JSON.parse(raw); } catch { response.writeHead(400).end(JSON.stringify(rpcError(null, -32700, "Parse error"))); return; }
  const { id: requestId, method, params = {} } = body;
  try {
    if (method === "GetTask") {
      const task = tasks.get(params.id); if (!task) throw Object.assign(new Error("Task not found"), { code: -32602 });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { task: taskView(task) } })); return;
    }
    if (method !== "SendMessage") throw Object.assign(new Error("Method not found"), { code: -32601 });
    const message = params.message || {}; const text = message.parts?.map((part) => part.text || "").join(" ") || "";
    let task;
    if (message.taskId) {
      task = tasks.get(message.taskId); if (!task) throw Object.assign(new Error("Task not found"), { code: -32602 });
      if (["TASK_STATE_COMPLETED", "TASK_STATE_CANCELED", "TASK_STATE_FAILED"].includes(task.status.state)) throw Object.assign(new Error("Task is terminal"), { code: -32602 });
      task.history.push(message); await continueTask(task, text, traceFrom(request));
    } else {
      const args = parseReservation(text);
      task = { id: id("task"), contextId: id("ctx"), history: [message], artifacts: [], status: { state: "TASK_STATE_SUBMITTED" } }; tasks.set(task.id, task);
      task.status = { state: "TASK_STATE_WORKING" }; await begin(task, args || { sala: "", inicio: "", fim: "", responsavel: "" }, traceFrom(request));
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { task: taskView(task) } }));
  } catch (error) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rpcError(requestId, error.code || -32603, error.message))); }
}).listen(PORT, () => console.error(`A2A agent listening on ${PORT}`));
