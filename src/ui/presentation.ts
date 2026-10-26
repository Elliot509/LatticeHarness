import type {
  ApprovalDecisionView,
  MessageView,
  SendMode,
  SteeringView,
  TaskCapabilities,
  TaskOutcome,
  TaskSnapshot,
  TaskState,
  ToolActivityView,
  VerificationView,
} from "../server/protocol.js";

export type ActivityItem =
  | { kind: "message"; seq: number; value: MessageView }
  | { kind: "tool"; seq: number; value: ToolActivityView }
  | { kind: "verification"; seq: number; value: VerificationView }
  | { kind: "steering"; seq: number; value: SteeringView }
  | { kind: "approval"; seq: number; value: ApprovalDecisionView };

// One event, one row: a message that is also a steering record renders once,
// as the message (its steering state is metadata of that row).
export function taskActivity(task: TaskSnapshot): ActivityItem[] {
  const messageIds = new Set(task.messages.map((message) => message.id));
  return [
    ...task.messages.map((value): ActivityItem => ({ kind: "message", seq: value.seq, value })),
    ...task.tools.map((value): ActivityItem => ({ kind: "tool", seq: value.seq, value })),
    ...task.verifications.map((value): ActivityItem => ({ kind: "verification", seq: value.seq, value })),
    ...task.steering.filter((value) => !messageIds.has(value.id)).map((value): ActivityItem => ({ kind: "steering", seq: value.seq, value })),
    ...(task.approvalHistory ?? []).map((value): ActivityItem => ({ kind: "approval", seq: value.seq, value })),
  ].sort((left, right) => left.seq - right.seq);
}

export function toolSummaryPreview(tool: ToolActivityView, maxLength = 260): { text: string; shortened: boolean } {
  // Without a receipt the ledger only knows the attempt state.
  if (/^(?:UNKNOWN|CLAIMED|ADMITTED|INVALIDATED|RECONCILED)$/u.test(tool.summary.trim())) {
    const text = tool.summary.trim() === "UNKNOWN" ? "Sem resultado registrado: efeito incerto (veja Incertezas)"
      : tool.summary.trim() === "RECONCILED" ? "Resultado reconciliado depois de uma interrupção"
        : tool.summary.trim() === "INVALIDATED" ? "Não executada: a autorização caducou antes do início"
          : "Em andamento";
    return { text, shortened: false };
  }
  const normalized = tool.summary.trim().replace(/\s+/g, " ");
  const payloadStart = tool.tool === "edit" ? normalized.indexOf("{") : -1;
  const withoutStructuredPayload = payloadStart > 0 ? normalized.slice(0, payloadStart).trimEnd() : normalized;
  if (withoutStructuredPayload.length <= maxLength) {
    return { text: withoutStructuredPayload, shortened: withoutStructuredPayload !== normalized };
  }
  const clipped = withoutStructuredPayload.slice(0, maxLength).trimEnd();
  const lastWordBoundary = clipped.lastIndexOf(" ");
  const text = `${lastWordBoundary > maxLength * 0.7 ? clipped.slice(0, lastWordBoundary) : clipped}...`;
  return { text, shortened: true };
}

export function taskStateDescription(task: TaskSnapshot): string {
  if (task.stateReason.trim() !== "") return task.stateReason;
  switch (task.state) {
    case "WAITING":
      return "Execução pausada até a condição registrada mudar.";
    case "NEEDS_INPUT":
      return "A tarefa precisa de uma decisão antes de continuar.";
    case "BLOCKED":
      return "A execução não pode continuar nas restrições atuais.";
    case "COMPLETED":
      return "A tarefa chegou a um resultado final.";
    case "CANCELLED":
      return "A execução foi interrompida. Efeitos concluídos e incertos continuam visíveis.";
    case "INTERRUPTED":
      return "O aplicativo foi encerrado inesperadamente durante a execução. O que foi confirmado continua registrado; o que ficou incerto está listado abaixo.";
    case "READY":
    case "RUNNING":
      return "";
  }
}

// Capabilities come from the server. Older servers (and fixtures) without
// the field get the historical rules, so the UI never invents a broader
// affordance than the server used to grant.
export function effectiveCapabilities(task: TaskSnapshot): TaskCapabilities {
  if (task.capabilities !== undefined) return task.capabilities;
  const live = task.state === "RUNNING" || task.state === "WAITING";
  const no = (reason: string): { allowed: false; reason: string } => ({ allowed: false, reason });
  const send: TaskCapabilities["send"] = task.state === "COMPLETED"
    ? { allowed: true, mode: "follow-up" }
    : task.state === "CANCELLED" || task.state === "BLOCKED" || task.state === "INTERRUPTED"
      ? { ...no("A tarefa não aceita mensagens neste estado."), mode: "none" }
      : { allowed: true, mode: "steer" };
  return {
    send,
    stop: live ? { allowed: true } : no("Não há execução ativa."),
    resume: task.state !== "RUNNING" && task.resumable ? { allowed: true } : no("Retomada indisponível."),
    accept: no("Indisponível neste servidor."),
    reconcile: no("Indisponível neste servidor."),
    followUp: task.state === "COMPLETED" ? { allowed: true } : no("Indisponível."),
    archive: no("Indisponível neste servidor."),
  };
}

export function sendLabel(mode: SendMode, state: TaskState): { button: string; destination: string; placeholder: string } {
  switch (mode) {
    case "steer":
      return { button: "Enviar orientação", destination: "Orientação para a execução em andamento · o agente a recebe no próximo passo", placeholder: "Orientar a execução" };
    case "continue":
      return state === "NEEDS_INPUT"
        ? { button: "Responder e continuar", destination: "Sua resposta é registrada e a tarefa continua", placeholder: "Responder ao agente" }
        : { button: "Enviar e continuar", destination: "Sua mensagem é registrada e a tarefa continua de onde parou", placeholder: "Escreva para continuar" };
    case "follow-up":
      return { button: "Enviar", destination: "Continua a conversa numa nova etapa, com o contexto desta tarefa", placeholder: "Pergunte algo ou peça o próximo passo" };
    case "none":
      return { button: "Enviar", destination: "Mensagens indisponíveis neste estado", placeholder: "Mensagens indisponíveis" };
  }
}

// Label for the header and lists: the outcome refines COMPLETED/NEEDS_INPUT
// so a human acceptance never reads as an automatic verification.
export function displayStateLabel(task: { state: TaskState; outcome?: { kind: TaskOutcome["kind"] } | null | undefined; queuePosition?: number | null | undefined }): string {
  if (task.outcome?.kind === "accepted") return "Aceito por você";
  if (task.outcome?.kind === "unverified") return "Aguardando sua revisão";
  if ("queuePosition" in task && typeof task.queuePosition === "number") return "Na fila";
  switch (task.state) {
    case "READY": return "Pronto";
    case "RUNNING": return "Em execução";
    case "WAITING": return "Aguardando";
    case "NEEDS_INPUT": return "Precisa de resposta";
    case "BLOCKED": return "Bloqueado";
    case "COMPLETED": return "Concluído";
    case "CANCELLED": return "Interrompido";
    case "INTERRUPTED": return "Interrompida por falha";
  }
}

function providerProblem(text: string): string | null {
  const status = /status (\d{3})/u.exec(text)?.[1];
  if (status === "401" || status === "403") return `o provedor recusou a credencial (${status}). Confira a chave de API em Configurações › Providers`;
  if (status === "404") return "o provedor não encontrou o modelo ou o endereço (404). Confira o endpoint e o identificador do modelo";
  if (status === "429") return "o provedor limitou a taxa de pedidos (429). Aguarde um pouco antes de continuar";
  if (status !== undefined && status.startsWith("5")) return `o provedor respondeu com um erro interno (${status})`;
  if (status === "400" || status === "422") return `o provedor recusou o formato do pedido (${status}); pode ser incompatibilidade do modelo com chamadas de ferramenta`;
  if (/unreachable|not sent/u.test(text)) return `não foi possível conectar ao provedor (${/\(([A-Z_]+|blocked port)\)/u.exec(text)?.[1] ?? "sem conexão"}). Confira o endpoint e se o serviço está em execução`;
  if (/timed out/u.test(text)) return "o provedor não respondeu a tempo";
  if (/network request failed/u.test(text)) return "a conexão com o provedor caiu durante o pedido";
  if (/aborted/u.test(text)) return "o pedido ao provedor foi interrompido";
  if (/invalid JSON|no choices|no message/u.test(text)) return "o provedor devolveu uma resposta inválida";
  if (/needs an in-memory key|key/u.test(text)) return "falta configurar a chave de API deste provedor";
  return null;
}

function criterionProblem(text: string): string {
  if (/awaits human review/u.test(text)) return "este tipo de pedido não tem verificação automática: revise o resultado e aceite, ou continue a conversa";
  if (/unresolved effects/u.test(text)) return "há efeitos incertos que impedem a verificação automática";
  if (/no verification has run|test evidence/u.test(text)) return "nenhuma execução de testes comprovou o resultado";
  if (/verification failing/u.test(text)) return "os testes executados falharam";
  if (/test counts unknown/u.test(text)) return "o comando terminou, mas o Lattice não reconheceu resultados de testes";
  if (/final analysis response required/u.test(text)) return "o agente terminou sem uma resposta final";
  if (/directory inventory incomplete/u.test(text)) return "a listagem da pasta ficou incompleta";
  if (/not observed/u.test(text)) return "o arquivo ou pasta pedido não foi encontrado no projeto";
  return "o critério de conclusão ainda não foi comprovado";
}

// Runtime reasons are technical English by design (ledger language). The
// product shows what happened and what to do now, in Portuguese, and keeps
// the original text available as technical detail.
export function humanizeReason(state: TaskState, reason: string): { text: string; technical: string | null } {
  const raw = reason.trim();
  const technical = raw === "" ? null : raw;
  const with_ = (text: string): { text: string; technical: string | null } => ({ text, technical });
  if (raw === "" ) return { text: taskStateDescription({ state, stateReason: "" } as TaskSnapshot), technical: null };
  if (state === "COMPLETED") {
    const done = completedText(raw);
    if (done !== null) return with_(done);
  }
  if (/^loop started|continuing the same activation/u.test(raw)) return with_("O agente está trabalhando.");
  if (/^working: waiting for the model/u.test(raw)) return { text: "Aguardando a resposta do modelo…", technical: null };
  if (/^working: provider unreachable/u.test(raw)) return { text: "Provedor inacessível; tentando de novo automaticamente (o pedido não chegou a ser enviado)…", technical: null };
  if (/^working: running /u.test(raw)) return { text: `Executando ${/running (\S+)/u.exec(raw)?.[1] ?? "ferramenta"}…`, technical: null };
  if (/^task created/u.test(raw)) return with_("Tarefa criada e pronta para começar.");
  if (/^queued: /u.test(raw)) return with_(`Na fila: começa sozinha quando a tarefa em execução terminar (posição ${/position (\d+)/u.exec(raw)?.[1] ?? "?"}). Use Interromper para tirá-la da fila.`);
  if (/^removed from the queue/u.test(raw)) return with_("Removida da fila. Continue quando quiser.");
  if (/resumed|manual resume/u.test(raw)) return with_("Pronta para continuar de onde parou.");
  if (/^accepted by human/u.test(raw)) return with_(`Você aceitou este resultado. Isso registra sua decisão; não equivale a uma verificação automática.${/UNKNOWN/u.test(raw) ? " Efeitos incertos continuam registrados abaixo." : ""}`);
  if (/^executor lost/u.test(raw)) return with_("O Lattice foi encerrado inesperadamente durante a execução. O que foi confirmado continua registrado; o que ficou incerto está listado abaixo. Nada foi repetido automaticamente.");
  if (/^acceptance criteria unverified/u.test(raw)) return with_(`O agente terminou, mas ${criterionProblem(raw)}.`);
  if (/^no progress/u.test(raw)) return with_("O agente repetiu as mesmas ações sem avançar. Envie uma orientação para continuar.");
  if (/^approval required: /u.test(raw)) return with_(`O agente pede sua confirmação para ${raw.slice("approval required: ".length)}. Aprove, negue, ou responda com uma mensagem.`);
  if (/^stop requested/u.test(raw)) return with_("Você interrompeu a execução. Envie uma mensagem ou continue quando quiser.");
  if (/^interrupted by user/u.test(raw)) return with_("A execução foi interrompida.");
  if (/^model invocation/u.test(raw)) {
    const problem = providerProblem(raw);
    const uncertain = /UNKNOWN/u.test(raw);
    return with_(`A chamada ao modelo falhou${problem === null ? "" : `: ${problem}`}.${uncertain ? " O provedor pode ter processado e cobrado a chamada; ela continua contada como consumo possível." : ""}`);
  }
  if (/budget (?:exhausted|exceeded)/u.test(raw)) return with_("O limite de uso configurado para esta tarefa acabou. Continue numa nova tarefa de seguimento.");
  if (/^contract expired/u.test(raw)) return with_("A autorização desta tarefa expirou. Continue numa nova tarefa de seguimento.");
  if (/^tool effect UNKNOWN/u.test(raw)) return with_("Uma ação ficou com efeito incerto. Verifique abaixo antes de continuar.");
  if (/iteration budget exhausted/u.test(raw)) return with_("O limite de passos desta execução foi atingido sem conclusão verificada.");
  if (/^waiting: /u.test(raw)) return with_(`Aguardando: ${raw.slice("waiting: ".length).split(" (wait ")[0] ?? ""}. Mantenha o Lattice aberto.`);
  if (/process cleanup remains UNKNOWN/u.test(raw)) return with_("Um processo iniciado pela tarefa não pôde ser confirmado como encerrado. Verifique antes de continuar.");
  if (/exceed the context limit/u.test(raw)) return with_("As regras desta tarefa não cabem no limite de contexto configurado.");
  if (/not admitted|claim refused/u.test(raw)) return with_("O Lattice não autorizou a próxima ação nas condições atuais da tarefa.");
  if (state === "BLOCKED") return with_("A execução parou por um problema técnico. Veja os detalhes abaixo.");
  return { text: raw, technical: null };
}

// Contract criteria in product language; the exact criterion stays
// available as technical detail where it is shown.
export function criterionLabel(criterion: string): string {
  const exists = /^(directory|file)-exists:(.+)$/u.exec(criterion);
  if (exists !== null) return `${exists[1] === "directory" ? "a pasta" : "o arquivo"} “${exists[2] ?? ""}” existe no projeto`;
  const listing = /^directory-listing:(all|files|directories):(immediate|recursive):(.+)$/u.exec(criterion);
  if (listing !== null) return `listagem completa ${listing[1] === "files" ? "dos arquivos" : listing[1] === "directories" ? "das pastas" : "das entradas"} de “${listing[3] === "." ? "projeto" : listing[3] ?? ""}”${listing[2] === "recursive" ? ", incluindo subpastas" : ""}`;
  switch (criterion) {
    case "response": return "uma resposta do agente";
    case "tests-pass": return "testes do projeto passando, observados pelo Lattice";
    case "unverified": return "sua revisão (sem verificação automática)";
    case "clarification-required": return "um critério mais claro (pedido ambíguo)";
    default: return criterion;
  }
}

function completedText(raw: string): string | null {
  const parts: string[] = [];
  if (/analysis response provided/u.test(raw)) parts.push("Resposta entregue. O Lattice registra que houve resposta; não verifica se o conteúdo está correto.");
  if (/^verified: |verified: .* exit 0/u.test(raw)) parts.push("Testes do projeto executados e aprovados, observados pelo Lattice.");
  const exists = [...raw.matchAll(/(directory|file)-exists:([^;]+?) observed on filesystem/gu)];
  for (const match of exists) parts.push(`${match[1] === "directory" ? "A pasta" : "O arquivo"} “${(match[2] ?? "").trim()}” existe no projeto.`);
  if (/directory inventory delivered/u.test(raw)) parts.push("Listagem completa da pasta entregue.");
  if (/effects are not certified by response/u.test(raw)) parts.push("Alterações feitas durante a resposta não são certificadas por ela.");
  return parts.length === 0 ? null : parts.join(" ");
}

function seconds(ms: string): string {
  const value = Number(ms);
  return Number.isFinite(value) ? (value < 1000 ? `${value} ms` : `${(value / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`) : `${ms} ms`;
}

// Action language for the timeline row (PG-022). The exact runtime summary
// stays in the inspector; anything unrecognized is shown as recorded.
export function toolActionText(tool: ToolActivityView): string {
  const raw = tool.summary.trim().replace(/\s+/gu, " ");
  const body = raw.replace(/^\[[a-z.]+\] [a-z-]+: /u, "");
  let match: RegExpExecArray | null;
  if ((match = /^(.+?) lines (\d+)-(\d+) of (\d+);/u.exec(body)) !== null) return `Leu ${match[1]} · linhas ${match[2]}–${match[3]} de ${match[4]}`;
  if ((match = /^empty file (.+?);/u.exec(body)) !== null) return `Leu ${match[1]} · arquivo vazio`;
  if ((match = /^(binary|non-UTF8) file (.+?) /u.exec(body)) !== null) return `Leu ${match[2]} · conteúdo ${match[1] === "binary" ? "binário" : "não UTF-8"} não exibido`;
  if ((match = /^Directory "(.+?)"; .*Observed entries (\d+)-(\d+) of (\d+)/u.exec(body)) !== null) return `Listou ${match[1] === "." ? "a pasta do projeto" : match[1]} · entradas ${Number(match[2]) + 1}–${match[3]} de ${match[4]}`;
  if ((match = /^(at least )?(\d+) match\(es\)(, search incomplete)?\. scope (.+?), (\d+) files read/u.exec(body)) !== null) return `Buscou em ${match[4] === "." ? "todo o projeto" : match[4]} · ${match[1] === undefined ? "" : "pelo menos "}${match[2]} ${match[2] === "1" ? "ocorrência" : "ocorrências"} em ${match[5]} ${match[5] === "1" ? "arquivo lido" : "arquivos lidos"}${match[3] === undefined ? "" : " (busca incompleta)"}`;
  if ((match = /^exit (-?\d+) in (\d+)ms/u.exec(body)) !== null) return `${tool.target ?? "Comando"} terminou com código ${match[1]} em ${seconds(match[2] ?? "0")}${match[1] === "0" ? "" : " (falha)"}`;
  if ((match = /^terminated by signal (\S+) in (\d+)ms/u.exec(body)) !== null) return `${tool.target ?? "Comando"} encerrado por sinal ${match[1]} após ${seconds(match[2] ?? "0")}`;
  if ((match = /^replaced one literal occurrence in (.+?);/u.exec(body)) !== null) return `Editou ${match[1]} · 1 trecho substituído`;
  if ((match = /^created (.+?);/u.exec(body)) !== null) return `Criou ${match[1]}`;
  if ((match = /^deleted (.+)$/u.exec(body)) !== null) return `Apagou ${match[1]}`;
  if ((match = /^renamed (.+?) to (.+?);/u.exec(body)) !== null) return `Renomeou ${match[1]} para ${match[2]}`;
  if ((match = /^process started \(handle (\S+), pid (\S+)\)/u.exec(body)) !== null) return `Iniciou um processo (pid ${match[2]})`;
  if (/^stale-version|changed since it was read/u.test(body)) return "Edição recusada: o arquivo mudou desde a leitura; o agente precisa ler de novo";
  if (/^Tool \S+ denied: /u.test(raw)) return `Recusada pelo Lattice: ${raw.replace(/^Tool \S+ denied: /u, "")}`;
  return body;
}

// Start time carried by a live "working:" phase, for an elapsed counter.
export function phaseStartedAt(reason: string): number | null {
  const iso = / since (\S+)$/u.exec(reason)?.[1];
  const parsed = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}
