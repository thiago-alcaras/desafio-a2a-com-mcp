# A Ponte: um agente A2A com MCP por dentro

Implementacao do desafio com dois processos HTTP independentes:

- `servidor-mcp/`: servidor MCP Streamable HTTP em `http://localhost:7301/mcp`.
- `agente/`: host MCP e servidor A2A JSON-RPC em `http://localhost:7300/a2a`.

O agente nao usa LLM. Ele interpreta o formato fixo do pedido e traduz estados de protocolo entre A2A e MCP.

## Como rodar

Requisitos: Node.js 20+, npm e Python 3.10+.

Instale as dependencias a partir de um clone limpo:

```bash
npm install
```

Gere a chave usada para assinar o `requestState`. Nunca a versione ou publique:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Exporte o valor gerado e suba cada processo em um terminal separado.

No PowerShell:

```powershell
$env:REQUEST_STATE_SECRET = "cole-a-chave-gerada-aqui"
npm run start:mcp
```

```powershell
npm run start:agente
```

No bash:

```bash
export REQUEST_STATE_SECRET="cole-a-chave-gerada-aqui"
npm run start:mcp
```

```bash
npm run start:agente
```

Execute o validador com os dois processos em execucao:

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

As portas podem ser alteradas com `MCP_PORT`, `AGENT_PORT` e `MCP_URL`; os valores padrao sao os esperados pelo validador.

## Onde a ponte acontece

No servidor, `runTool` em `servidor-mcp/index.js` transforma um conflito em `resultType: "input_required"`, com a elicitation e um `requestState` assinado. No agente, `begin` em `agente/index.js` recebe esse resultado cru, guarda o estado opaco somente na Task e a move para `TASK_STATE_INPUT_REQUIRED`. Em `continueTask`, a resposta `escolha=<id>` e convertida em `inputResponses`; o mesmo `requestState` e reenviado ao MCP em uma nova requisicao JSON-RPC. O agente nao abre, decodifica ou reconstrui esse estado.

Antes da primeira chamada de reserva, o agente executa `tools/list` e le `politica://uso` via HTTP. Todo request MCP emitido pelo host inclui `_meta`, a capability de elicitation form mode e o `traceparent` recebido na chamada A2A.

## Decisoes tecnicas

O `requestState` tem payload JSON serializado em base64url, assinatura HMAC-SHA-256 e expiracao de 15 minutos. A chave vem exclusivamente de `REQUEST_STATE_SECRET`, exige pelo menos 32 bytes e o servidor rejeita estados adulterados, malformados ou expirados com erro JSON-RPC `-32602`. Os argumentos do retry sao ignorados: o servidor usa o pedido selado no estado.

As reservas permanecem em memoria durante a execucao. As Tasks A2A tambem ficam em memoria, indexadas pelo seu `id`; cada Task pausada armazena seu proprio `requestState`, chave de elicitation e lista de alternativas. Isso evita cruzamento de estado entre duas pausas simultaneas. O servidor usa o codec oficial `createRequestStateCodec` do `@modelcontextprotocol/server` v2, travado no lockfile; o transporte HTTP/JSON-RPC e mantido explicito para deixar visiveis os contratos exigidos pelo desafio.

## Saida do validador

Ultima execucao local, com os dois processos recem-iniciados:

```text
PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata
PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
