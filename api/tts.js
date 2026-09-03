/* ==================================================================
   api/tts.js — Narração sob demanda (Vercel Serverless Function, Node.js)
   Protocolo Confidencial · O Manto Tupinambá (ICH/UnB)

   Recebe POST { text: string } e devolve o áudio MP3 (Content-Type:
   audio/mpeg) narrado pelo mesmo serviço, voz e ritmo já usados com
   sucesso no resto do app (pt-BR-ThalitaMultilingualNeural, rate -15%)
   — permitindo que um aluno digite um texto qualquer e ouça a mesma
   narração "no estilo" do restante do dossiê.

   Este arquivo é só a camada HTTP (validação de entrada + tradução de
   erros para status codes). A lógica real do protocolo "Edge Read Aloud"
   está em lib/edge-tts-client.js (porta fiel do pacote Python edge-tts
   7.2.8), testada isoladamente ANTES de ser ligada aqui — ver o histórico
   da sessão que criou este arquivo para o script de teste e os áudios de
   exemplo gerados.

   Segurança/abuso: a voz e o rate são SEMPRE os valores fixos abaixo,
   nunca lidos do corpo da requisição — isso garante que este endpoint
   público não possa ser usado para gerar qualquer voz/idioma arbitrário
   fora do propósito do app, e mantém a narração consistente com o resto
   do dossiê. O limite de 700 caracteres é só uma salvaguarda razoável
   contra abuso do endpoint gratuito da Microsoft, não uma limitação de
   custo (o serviço é gratuito).
   ================================================================== */

'use strict';

const { synthesizeToMp3 } = require('../lib/edge-tts-client');

const MAX_TEXT_LENGTH = 700;
const TIMEOUT_MS = 15000;

// Valores fixos, iguais aos já usados com sucesso no resto do app —
// nunca aceitos do cliente (ver nota de segurança acima).
const VOICE = 'pt-BR-ThalitaMultilingualNeural';
const RATE = '-15%';

function sendJsonError(res, statusCode, message) {
  res.status(statusCode).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({ error: message }));
}

// Aceita req.body já parseado como objeto (comportamento padrão do
// runtime Node da Vercel para Content-Type: application/json), mas
// também tolera vir como string (corpo bruto) ou ausente, para não
// depender de um detalhe de configuração do body parser.
function getJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      return JSON.parse(req.body);
    } catch (_err) {
      return undefined;
    }
  }
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    try {
      return JSON.parse(req.body.toString('utf-8'));
    } catch (_err) {
      return undefined;
    }
  }
  return undefined;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJsonError(res, 405, 'Método não permitido. Use POST.');
      return;
    }

    const body = getJsonBody(req);
    if (!body || typeof body !== 'object') {
      sendJsonError(res, 400, 'Corpo da requisição inválido: envie JSON com { text: string }.');
      return;
    }

    const { text } = body;
    if (typeof text !== 'string') {
      sendJsonError(res, 400, 'Campo "text" é obrigatório e deve ser uma string.');
      return;
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      sendJsonError(res, 400, 'Campo "text" não pode ser vazio.');
      return;
    }

    if (text.length > MAX_TEXT_LENGTH) {
      sendJsonError(res, 400, `Texto excede o limite de ${MAX_TEXT_LENGTH} caracteres.`);
      return;
    }

    // Timeout de segurança adicional cobrindo a chamada inteira (o módulo
    // já aplica um timeout por conexão internamente); nunca deixa a
    // function pendurada sem resposta.
    const audioBuffer = await withTimeout(
      synthesizeToMp3(trimmed, { voice: VOICE, rate: RATE, timeoutMs: TIMEOUT_MS }),
      TIMEOUT_MS + 2000,
      'Tempo limite excedido ao gerar a narração.'
    );

    res.status(200);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.send(audioBuffer);
  } catch (err) {
    // Nunca deixa a requisição sem resposta: qualquer falha (timeout,
    // erro de rede, erro de parsing do protocolo) vira um 502 com corpo
    // JSON simples. Detalhe do erro só no log do servidor, nunca
    // vazado por completo ao cliente.
    // eslint-disable-next-line no-console
    console.error('[api/tts] falha ao gerar narração:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJsonError(res, 502, 'Não foi possível gerar a narração no momento. Tente novamente em instantes.');
    } else {
      try {
        res.end();
      } catch (_e) {
        /* conexão já encerrada */
      }
    }
  }
};

// Pede à Vercel até 15s de execução (o mesmo teto do timeout interno
// acima). O teto realmente aplicado depende do plano da conta — em
// planos que não permitem configurar isso, este valor é ignorado e o
// padrão da plataforma prevalece; ver caveat correspondente na resposta
// desta tarefa.
module.exports.config = {
  maxDuration: 15,
};
